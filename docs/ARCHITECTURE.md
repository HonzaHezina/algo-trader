# Architektura — AlgoTrader

## Přehled komponent

Systém se skládá z 6 runtime komponent, které komunikují přes PostgreSQL (sdílený stav) a n8n (orchestrace).

## Komponenty

### 1. Scanner Agent (OpenClaw)

**Účel:** Periodicky skenuje trh a identifikuje breakout kandidáty.

**Trigger:** n8n cron každé 4 hodiny (0:00, 4:00, 8:00, 12:00, 16:00, 20:00 UTC).

**Vstup:**
- Seznam sledovaných coinů z tabulky `watchlist`
- Cenová data z Binance API (4h OHLCV, posledních 200 svíček)
- Aktuální ATR14, volume SMA20 (počítá sám z OHLCV)

**Výstup:**
- Zápis do tabulky `signals` se statusem `candidate`
- JSON objekt s: `coin`, `direction`, `signal_type`, `breakout_price`, `momentum`, `volume_ratio`, `atr14`, `timestamp`

**Logika detekce:**
```
LONG signál:
  close > highest_high(30) AND
  rate_of_change(12) > 0.02 AND
  volume > volume_sma(20)

SHORT signál:
  close < lowest_low(30) AND
  rate_of_change(12) < -0.02 AND
  volume > volume_sma(20)
```

**Nepočítá:** Entry/stop/TP ceny, position sizing, risk check — to dělá Analyst.

---

### 2. Analyst Agent (OpenClaw)

**Účel:** Převezme kandidáty ze Scanneru, obohatí je o analýzu a vytvoří hotové trade setup karty.

**Trigger:** n8n webhook — volán automaticky po dokončení Scanner runu.

**Vstup:**
- Záznamy ze `signals` se statusem `candidate`
- Cenová data z Binance API (pro přesné výpočty)
- Volitelně: predikce z MindsDB (confidence, predicted_direction)

**Výstup:**
- Update záznamu v `signals` na status `analyzed`
- JSON trade karta:

```json
{
  "signal_id": "uuid",
  "coin": "SOL/USDT",
  "direction": "long",
  "timeframe": "4h",
  "entry_price": 142.50,
  "stop_loss": 135.20,
  "take_profit": null,
  "trailing_stop_atr_mult": 2.5,
  "trail_activation_pct": 0.04,
  "risk_per_unit_pct": 5.12,
  "position_size_usdt": 390.00,
  "risk_amount_usdt": 20.00,
  "risk_reward_ratio": null,
  "confidence_score": 0.72,
  "reasoning": "SOL prolomil 30-period high na zvýšeném volume (1.8x avg). ATR14 = $3.65. Momentum 12-period ROC = +4.2%.",
  "mindsdb_prediction": {
    "direction": "bullish",
    "confidence": 0.68,
    "predicted_move_pct": 8.5
  }
}
```

**Výpočty:**
```
initial_stop = entry_price - (2.0 × ATR14)           # long
initial_stop = entry_price + (2.0 × ATR14)           # short
trailing_stop_distance = 2.5 × ATR14                  # dynamický
risk_per_unit_pct = abs(entry - stop) / entry × 100
position_size = (capital × 0.02) / risk_per_unit_pct  # max risk $20 při $1000
position_size = min(position_size, capital × 0.45)     # max 45% kapitálu
risk_reward_ratio = null                               # trailing stop → R:R se počítá až ex-post
```

---

### 3. Risk Controller Agent (OpenClaw)

**Účel:** Validuje každý navržený obchod proti pravidlům. Má právo vetovat.

**Trigger:** n8n webhook — volán po Analyst agentovi.

**Vstup:**
- Trade karta z Analyst agenta
- Aktuální stav portfolia z tabulky `portfolio`
- Otevřené pozice z tabulky `trades` (status = `open`)
- Risk konfigurace z tabulky `risk_config`

**Výstup:**
- Update `signals` na status `approved` nebo `rejected`
- Pokud rejected: důvod zamítnutí v poli `rejection_reason`

**Pravidla (hard rules — nelze přepsat):**

```yaml
max_risk_per_trade_pct: 2.0          # max ztráta na 1 obchod = 2% kapitálu
max_open_positions: 3                 # max 3 souběžné pozice
max_daily_loss_pct: 4.0              # max denní ztráta = 4% kapitálu
max_monthly_drawdown_pct: 6.0        # po dosažení → systém STOP na zbytek měsíce
min_risk_reward: 1.5                  # min odhadované R:R (pokud je spočitatelné)
max_position_size_pct: 45.0          # max 45% kapitálu v jedné pozici
max_correlation: 0.7                  # neotevírat 2 vysoce korelované pozice
min_capital: 50.0                     # pod $50 → systém STOP
cooldown_after_loss_hours: 4          # po ztrátě čekat min 4h
max_consecutive_losses_pause: 4       # po 4 ztrátách za sebou → pauza 24h
```

**Validační sekvence:**
1. Check: je dost kapitálu? (`available_capital > position_size`)
2. Check: nepřekračuje max risk? (`risk_amount <= capital * 0.02`)
3. Check: nepřekračuje max pozice? (`count(open_trades) < 3`)
4. Check: denní loss limit? (`today_losses < capital * 0.04`)
5. Check: měsíční drawdown? (`month_drawdown < capital * 0.06`)
6. Check: cooldown po ztrátě? (`last_loss_time + 4h < now`)
7. Check: consecutive losses pause? (`consecutive_losses < 4`)
8. Check: korelace s otevřenými? (zjednodušeně: neotevírat 2 pozice na stejném coinu)
9. Pokud vše OK → `approved`
10. Pokud cokoliv selže → `rejected` + důvod

---

### 4. Notifier (n8n workflow)

**Účel:** Doručuje schválené trade karty uživateli přes Telegram a zpracovává odpovědi.

**Trigger:** n8n webhook — po Risk Controller approval.

**Formát Telegram zprávy:**

```
🟢 LONG Setup #1 — SOL/USDT

Entry:      $142.50
Stop Loss:  $135.20 (-5.1%)
Trail:      2.5× ATR (aktivace na +4%)
Risk:       $20.00 (2.0% portfolia)
Pozice:     $390.00
Confidence: 72%

📊 SOL prolomil 30-period high na zvýšeném volume.
🤖 MindsDB: bullish, +8.5% predikce

/approve_1  /reject_1  /modify_1
```

**Zpracování odpovědí:**
- `/approve_1` → spustí Executor workflow
- `/reject_1` → update signal na `rejected_by_user`
- `/modify_1` → odpoví s možnostmi úprav (stop, size)
- Timeout 30 minut → auto-reject

---

### 5. Executor (n8n workflow)

**Účel:** Odesílá obchodní příkazy na burzu/DEX po schválení uživatelem.

**Trigger:** Telegram callback `/approve_X`

**Sekvence:**
1. Načti signal z DB
2. Ověř, že cena se nepohnula víc než 1% od doby analýzy
3. Pokud cena OK → pošli market order přes Binance API
4. Zapiš do tabulky `trades` se statusem `open`
5. Nastav initial stop-loss jako OCO order (pokud burza podporuje)
6. Notifikuj uživatele: "✅ SOL/USDT LONG otevřen @ $142.50"
7. Pokud cena NOT OK → notifikuj: "⚠️ Cena se pohnula, setup expiroval"

**Binance API volání:**
```
POST /api/v3/order
{
  "symbol": "SOLUSDT",
  "side": "BUY",
  "type": "MARKET",
  "quoteOrderQty": 390.00
}
```

---

### 6. Monitor (n8n workflow)

**Účel:** Každých 15 minut kontroluje otevřené pozice a spravuje trailing stopy.

**Trigger:** n8n cron každých 15 minut.

**Logika pro LONG pozici:**
```python
current_price = get_price(coin)
current_high = get_candle_high(coin, "15m")

# Aktualizace trailing stop
if profit_pct >= trail_activation_pct:
    new_stop = current_high - (trailing_atr_mult * current_atr14)
    if new_stop > current_stop:
        update_stop(trade_id, new_stop)
        log("Trailing stop posunut na {new_stop}")

# Kontrola stop-loss
if current_price <= current_stop:
    execute_market_sell(trade_id)
    close_trade(trade_id, exit_price=current_price, reason="trailing_stop")
    notify_user("🔴 SOL/USDT LONG uzavřen @ {price} — trailing stop")
    update_portfolio()
```

**Po uzavření obchodu:**
1. Zapiš exit do `trades` (exit_price, exit_time, pnl, reason)
2. Aktualizuj `portfolio` (available_capital, total_pnl)
3. Zapiš do `audit_log`
4. Notifikuj uživatele s výsledkem

---

## Datové toky — Sequence Diagram

```
n8n Cron (4h)
    │
    ▼
Scanner ──[candidates]──▶ DB (signals: candidate)
    │
    ▼
n8n Webhook
    │
    ▼
Analyst ──[trade cards]──▶ DB (signals: analyzed)
    │                          │
    │                    MindsDB (optional)
    ▼
n8n Webhook
    │
    ▼
Risk Controller ──[approved/rejected]──▶ DB (signals: approved)
    │
    ▼
n8n Webhook
    │
    ▼
Notifier ──[Telegram msg]──▶ Uživatel
    │                            │
    │                     /approve /reject
    │                            │
    ▼                            ▼
n8n Telegram Bot ◀──────────────┘
    │
    ▼
Executor ──[market order]──▶ Binance API
    │
    ▼
DB (trades: open)
    │
    ▼
Monitor (15 min cron) ──[trailing stop check]──▶ Binance API
    │
    ▼
DB (trades: closed) ──▶ Notifier ──▶ Telegram
```

---

## Environment & Deployment

**Hetzner VPS (Coolify):**
- PostgreSQL container
- n8n container (s persistent storage)
- OpenClaw agents (jako n8n code nodes nebo separátní kontejnery)
- MindsDB container (volitelný, začni bez něj)

**Doporučený deployment order:**
1. PostgreSQL + migrations
2. n8n + základní workflows (scanner trigger, notifier)
3. Scanner agent (nejjednodušší, ověří data pipeline)
4. Analyst agent
5. Risk Controller agent
6. Executor + Monitor workflows
7. MindsDB (až systém běží stabilně)

**Monitoring:**
- n8n execution log (built-in)
- PostgreSQL `audit_log` tabulka
- Telegram notifikace chyb do separátního kanálu
