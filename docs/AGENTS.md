# OpenClaw Agents — Specifikace

Každý agent je definován svým system promptem, tools, input/output schématem a chybovými stavy.

---

## Agent 1: Scanner

### Konfigurace

```yaml
agent_id: scanner
name: "Market Scanner"
model: claude-sonnet-4-20250514  # nebo jiný dle OpenClaw
max_tokens: 2000
temperature: 0.1  # nízká — chceme konzistentní výstup
```

### System Prompt

```
Jsi Market Scanner agent v automatizovaném obchodním systému. Tvůj úkol je analyzovat cenová data a identifikovat breakout signály.

PRAVIDLA:
1. Hledáš LONG breakouty (close > highest_high za 30 svíček) a SHORT breakouty (close < lowest_low za 30 svíček).
2. Breakout musí být podpořen momentum (12-period rate of change > 2% pro long, < -2% pro short).
3. Volume musí být nad 20-period SMA volume.
4. Pro každý signál vrať strukturovaný JSON.
5. Pokud žádný coin nesplňuje podmínky, vrať prázdné pole.
6. NIKDY nevymýšlej data. Pracuj pouze s daty, která dostaneš.

VÝSTUPNÍ FORMÁT:
Vrať POUZE validní JSON pole, žádný další text.

[
  {
    "coin": "SOL/USDT",
    "direction": "long",
    "signal_type": "breakout_high",
    "current_price": 142.50,
    "breakout_level": 141.80,
    "momentum_roc12": 0.042,
    "volume_ratio": 1.8,
    "atr14": 3.65,
    "atr7": 4.10,
    "timestamp": "2026-04-04T12:00:00Z"
  }
]
```

### Tools

```yaml
tools:
  - name: fetch_ohlcv
    description: "Získá OHLCV data z Binance API"
    parameters:
      symbol: string    # např. "SOLUSDT"
      interval: string  # "4h"
      limit: integer    # 200
    returns: "Pole objektů {timestamp, open, high, low, close, volume}"

  - name: get_watchlist
    description: "Načte seznam sledovaných coinů z databáze"
    parameters: {}
    returns: "Pole objektů {symbol, name, is_active}"

  - name: save_signal
    description: "Uloží nalezený signál do databáze"
    parameters:
      coin: string
      direction: string     # "long" | "short"
      signal_type: string
      signal_data: object   # celý JSON signálu
    returns: "signal_id (UUID)"
```

### Tool implementace (n8n HTTP Request nodes)

```javascript
// fetch_ohlcv — n8n HTTP Request
// URL: https://api.binance.com/api/v3/klines
// Query: symbol={{symbol}}&interval={{interval}}&limit={{limit}}
// Transformace response:
const candles = $json.map(c => ({
  timestamp: new Date(c[0]).toISOString(),
  open: parseFloat(c[1]),
  high: parseFloat(c[2]),
  low: parseFloat(c[3]),
  close: parseFloat(c[4]),
  volume: parseFloat(c[5])
}));

// get_watchlist — n8n PostgreSQL node
// SELECT symbol, name, is_active FROM watchlist WHERE is_active = true

// save_signal — n8n PostgreSQL node
// INSERT INTO signals (coin, direction, signal_type, signal_data, status, created_at)
// VALUES ($1, $2, $3, $4, 'candidate', NOW()) RETURNING id
```

---

## Agent 2: Analyst

### Konfigurace

```yaml
agent_id: analyst
name: "Trade Analyst"
model: claude-sonnet-4-20250514
max_tokens: 3000
temperature: 0.2
```

### System Prompt

```
Jsi Trade Analyst agent. Dostáváš breakout signály od Scanner agenta a tvůj úkol je vytvořit kompletní trade setup kartu.

VSTUP: Signál se surovými daty (coin, direction, cena, ATR, volume).
VÝSTUP: Kompletní trade karta s entry, stop-loss, position sizing a zdůvodněním.

PRAVIDLA VÝPOČTŮ:

1. ENTRY PRICE = aktuální close cena (market order)

2. STOP LOSS (initial):
   - LONG: entry_price - (2.0 × ATR14)
   - SHORT: entry_price + (2.0 × ATR14)
   - Max stop distance: 12% od entry (pokud ATR dá víc, ořízni na 12%)

3. TRAILING STOP:
   - Distance: 2.5 × ATR14
   - Aktivace: po dosažení +4% zisku
   - Typ: posunuje se JEN ve směru zisku, nikdy zpět

4. POSITION SIZING:
   - Risk per trade: 2% kapitálu (načti z portfolio tabulky)
   - position_size = (capital × 0.02) / risk_per_unit_pct
   - Max position size: 45% kapitálu
   - Risk per unit = abs(entry - stop) / entry

5. CONFIDENCE SCORE (0.0 - 1.0):
   - Základ 0.5
   - +0.1 pokud volume_ratio > 2.0
   - +0.1 pokud momentum_roc12 > 0.05 (nebo < -0.05 pro short)
   - +0.1 pokud MindsDB predikce souhlasí se směrem
   - -0.1 pokud ATR14 > 8% ceny (vysoká volatilita = menší jistota)
   - -0.1 pokud je víkend (nižší likvidita)

6. ZDŮVODNĚNÍ: 1-2 věty česky, stručně a fakticky.

VÝSTUPNÍ FORMÁT:
Vrať POUZE validní JSON, žádný další text.

{
  "signal_id": "uuid-z-inputu",
  "coin": "SOL/USDT",
  "direction": "long",
  "timeframe": "4h",
  "entry_price": 142.50,
  "stop_loss": 135.20,
  "trailing_stop_atr_mult": 2.5,
  "trail_activation_pct": 0.04,
  "risk_per_unit_pct": 5.12,
  "position_size_usdt": 390.00,
  "risk_amount_usdt": 20.00,
  "confidence_score": 0.72,
  "reasoning": "SOL prolomil 30-period high na zvýšeném volume (1.8x avg). Momentum silný (+4.2%).",
  "mindsdb_prediction": { ... } | null,
  "current_capital": 1000.00,
  "timestamp": "2026-04-04T12:05:00Z"
}
```

### Tools

```yaml
tools:
  - name: get_candidate_signals
    description: "Načte nezpracované signály ze Scanner agenta"
    parameters: {}
    returns: "Pole signálů se statusem 'candidate'"

  - name: get_portfolio
    description: "Načte aktuální stav portfolia"
    parameters: {}
    returns: "{available_capital, total_value, open_positions_count}"

  - name: get_mindsdb_prediction
    description: "Získá predikci z MindsDB modelu (volitelné)"
    parameters:
      coin: string
      timeframe: string
    returns: "{direction, confidence, predicted_move_pct} | null"

  - name: update_signal
    description: "Aktualizuje signál v DB s výsledkem analýzy"
    parameters:
      signal_id: string
      status: string          # "analyzed"
      trade_card: object      # celý JSON trade karty
    returns: "boolean"
```

---

## Agent 3: Risk Controller

### Konfigurace

```yaml
agent_id: risk_controller
name: "Risk Controller"
model: claude-sonnet-4-20250514
max_tokens: 1500
temperature: 0.0  # nulová — deterministické rozhodování
```

### System Prompt

```
Jsi Risk Controller agent. Tvůj JEDINÝ úkol je validovat navržené obchody proti risk pravidlům. Nemáš názor na trh. Neposuzuješ kvalitu signálu. Jen kontroluješ pravidla.

PRAVIDLA (hard rules — NIKDY je neporušíš):

1. max_risk_per_trade: 2.0% kapitálu
2. max_open_positions: 3
3. max_daily_loss: 4.0% kapitálu
4. max_monthly_drawdown: 6.0% kapitálu → SYSTÉM STOP
5. max_position_size: 45% kapitálu
6. min_capital: $50 → pod tím SYSTÉM STOP
7. cooldown_after_loss: 4 hodiny po poslední ztrátě
8. max_consecutive_losses_pause: 4 ztráty za sebou → pauza 24h
9. no_duplicate_coin: neotevírat 2 pozice na stejném coinu
10. price_freshness: trade karta nesmí být starší než 30 minut

VSTUP: Trade karta + portfolio stav + otevřené pozice + risk config
VÝSTUP: approved/rejected + důvod

VÝSTUPNÍ FORMÁT:
{
  "signal_id": "uuid",
  "decision": "approved" | "rejected",
  "checks": [
    {"rule": "max_risk_per_trade", "passed": true, "value": "1.95%", "limit": "2.0%"},
    {"rule": "max_open_positions", "passed": true, "value": "1", "limit": "3"},
    ...
  ],
  "rejection_reason": null | "Denní loss limit překročen (4.2% > 4.0%)",
  "system_stop": false,
  "system_stop_reason": null
}

DŮLEŽITÉ:
- Pokud system_stop = true, VŠECHNY další obchody jsou automaticky rejected
- Nikdy neschvaluj obchod, který porušuje jakékoliv pravidlo
- Při pochybnostech ZAMÍTNI
```

### Tools

```yaml
tools:
  - name: get_trade_card
    description: "Načte trade kartu k validaci"
    parameters:
      signal_id: string
    returns: "Trade karta JSON"

  - name: get_portfolio_state
    description: "Načte kompletní stav portfolia"
    parameters: {}
    returns: "{available_capital, total_value, today_pnl, month_pnl, month_start_capital}"

  - name: get_open_trades
    description: "Načte všechny otevřené pozice"
    parameters: {}
    returns: "Pole otevřených obchodů"

  - name: get_recent_trades
    description: "Načte poslední uzavřené obchody"
    parameters:
      hours: integer  # 24
    returns: "Pole uzavřených obchodů za posledních N hodin"

  - name: get_risk_config
    description: "Načte risk pravidla z DB"
    parameters: {}
    returns: "Risk config objekt"

  - name: update_signal_status
    description: "Nastaví status signálu na approved/rejected"
    parameters:
      signal_id: string
      status: string
      checks: array
      rejection_reason: string | null
    returns: "boolean"
```

---

## Chybové stavy & Recovery

### Scanner selhání
- Binance API timeout → retry 3x s exponential backoff
- Žádné signály → normální stav, zaloguj a čekej na další run
- Chybná data (NaN, nulové ceny) → přeskoč coin, zaloguj warning

### Analyst selhání
- MindsDB nedostupný → pokračuj bez predikce (confidence -0.1)
- Portfolio query selhání → STOP, nenavrhuj obchod bez znalosti kapitálu
- Nevalidní výpočet (záporná pozice, NaN) → reject signál, zaloguj error

### Risk Controller selhání
- DB nedostupná → REJECT ALL (fail-safe)
- Nekonzistentní portfolio stav → REJECT ALL + alert do Telegram error kanálu
- Jakákoliv výjimka → REJECT (nikdy default approve)

### Executor selhání
- Binance order rejected → notifikuj uživatele, zaloguj
- Partial fill → zapiš skutečnou velikost, uprav stop
- Network timeout → retry 2x, pak cancel a notifikuj

### Monitor selhání
- Cena nedostupná → nemeň stop, čekej na další run
- DB write fail → retry, pokud opakovaně → Telegram alert
```
