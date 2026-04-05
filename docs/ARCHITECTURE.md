# Architektura — AlgoTrader

## Přehled komponent

Systém se skládá z 8 runtime komponent. Primární trading probíhá na Solana DEX (Birdeye + Jupiter). Binance slouží pouze pro finální výběr (offramp). Komunikace přes PostgreSQL (sdílený stav) a n8n (orchestrace).

## Komponenty

### 1. Scanner Agent (OpenClaw)

**Účel:** Periodicky skenuje trh a identifikuje breakout kandidáty.

**Trigger:** n8n cron každé 4 hodiny (0:00, 4:00, 8:00, 12:00, 16:00, 20:00 UTC).

**Vstup (CEX):**
- Seznam sledovaných coinů z tabulky `watchlist` (chain = 'cex')
- Cenová data z Binance API (4h OHLCV, posledních 200 svíček)

**Vstup (DEX — Solana):**
- Aktivní tokeny z `watchlist` (chain = 'solana') + metadata z `dex_tokens`
- Cenová data z Birdeye API (4h OHLCV, endpoint `/defi/ohlcv`)

**Výstup:**
- Zápis do tabulky `signals` se statusem `candidate`
- JSON objekt s: `symbol`, `direction`, `signal_type`, `breakout_price`, `momentum`, `volume_ratio`, `atr14`, `chain`, `timestamp`

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

**Chain-agnostický:** Stejná logika detekce pro CEX i DEX — liší se jen zdroj dat.

---

### 2. Analyst Agent (OpenClaw)

**Účel:** Převezme kandidáty ze Scanneru, obohatí je o analýzu a vytvoří hotové trade setup karty.

**Trigger:** n8n webhook — volán automaticky po dokončení Scanner runu.

**Vstup:**
- Záznamy ze `signals` se statusem `candidate`
- Stav portfolia (tabulka `portfolio` nebo `dex_portfolio` podle chain)
- Volitelně: predikce z MindsDB (confidence, predicted_direction)

**Výstup:**
- Update záznamu v `signals` na status `analyzed`
- JSON trade karta:

```json
{
  "signal_id": "uuid",
  "symbol": "JUP",
  "chain": "solana",
  "token_address": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "direction": "long",
  "timeframe": "4h",
  "entry_price": 0.92,
  "stop_loss": 0.85,
  "take_profit": null,
  "trailing_stop_atr_mult": 2.5,
  "trail_activation_pct": 0.04,
  "position_size_usdt": 40.00,
  "risk_amount_usdt": 4.00,
  "confidence_score": 0.72,
  "suggested_slippage": 50,
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
risk_per_unit_pct = abs(entry - stop) / entry × 100
position_size = (capital × 0.02) / risk_per_unit_pct
position_size = min(position_size, capital × 0.45)    # max 45% kapitálu
```

---

### 3. Risk Controller Agent (OpenClaw)

**Účel:** Validuje každý navržený obchod proti pravidlům. Má právo vetovat.

**Trigger:** n8n webhook — volán po Analyst agentovi.

**Vstup:**
- Trade karta z Analyst agenta
- Aktuální stav portfolia (`portfolio` nebo `dex_portfolio`)
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
max_position_size_pct: 45.0          # max 45% kapitálu v jedné pozici
min_capital: 50.0                     # pod $50 → systém STOP
cooldown_after_loss_hours: 4          # po ztrátě čekat min 4h
max_consecutive_losses_pause: 4       # po 4 ztrátách za sebou → pauza 24h
```

**Chain-agnostický:** Stejná pravidla pro CEX i DEX. DEX používá `dex_portfolio`.

---

### 4. Telegram Handler (n8n workflow 03)

**Účel:** Zpracovává příkazy uživatele. Routuje `/approve` na správný executor podle `signal.chain`.

**Příkazy:**
- `/approve_ID` → načte signal, zkontroluje chain, routuje na DEX nebo CEX executor
- `/reject_ID` → zamítne signal
- `/status` → stav portfolia (CEX) + balance
- `/trades` → posledních 10 uzavřených obchodů
- `/stop` / `/start` → systém on/off

**Chain routing:**
```
/approve_123
    │
    ▼
Načti signal (id=123) → zjisti signal.chain
    │
    ├── chain = 'solana' → POST /webhook/dex-execute   (Workflow 10)
    │
    └── chain = 'cex'    → POST /webhook/telegram-notify (Workflow 04)
```

---

### 5. CEX Executor (n8n workflow 04)

**Účel:** Odesílá market ordery na Binance po schválení uživatelem.

**Trigger:** Webhook `POST /webhook/telegram-notify`

**Sekvence:**
1. Načti signal z DB
2. Ověř, že cena se nepohnula víc než 1% od doby analýzy
3. Pošli market order přes Binance API
4. Zapiš do tabulky `trades` se statusem `open`
5. Notifikuj uživatele

---

### 6. DEX Executor (n8n workflow 10)

**Účel:** Exekuuje Solana DEX swap přes Jupiter po schválení uživatelem.

**Trigger:** Webhook `POST /webhook/dex-execute`

**Sekvence:**
1. Načti signal z DB (ověř chain = 'solana', status = 'approved')
2. Načti DEX portfolio (available_usdc)
3. Spočítej velikost pozice + dynamický slippage (30–300 bps podle poměru pozice/likviditě)
4. Fetch Jupiter quote (`GET /v6/quote?inputMint=USDC&outputMint={token}`)
5. Validuj quote (max price impact 3%)
6. Fetch Jupiter swap transaction (`POST /v6/swap`)
7. Pošli `POST /sign-and-send` na Solana Signer mikroservis
8. Po potvrzení: ulož trade do `trades`, aktualizuj `dex_portfolio`
9. Notifikuj uživatele s Solscan linkem

---

### 7. Solana Signer (mikroservis)

**Účel:** Izolovaná bezpečná komponenta pro podepisování Solana transakcí. Hot wallet přístupný pouze tomuto servisu.

**Proč separátní:** n8n Code Nodes nemohou používat npm balíčky jako `@solana/web3.js`.

**Endpointy:**
```
GET  /health         → { ok, wallet: pubkey, timestamp }
GET  /balance        → { ok, sol, usdc, wallet }
POST /sign-and-send  → { ok, signature, explorerUrl }
                       Body: { swapTransaction: "<base64>" }
```

**Build:** `node:20-alpine`, deps: `@solana/web3.js`, `bs58`, `express`

**Env:** `SOLANA_PRIVATE_KEY` (base58), `SOLANA_RPC_URL`, `SIGNER_PORT=3001`

---

### 8. Monitor (n8n workflow 05)

**Účel:** Každých 15 minut kontroluje otevřené CEX pozice a spravuje trailing stopy.

**Note:** DEX pozice jsou monitorovány samostatně (TODO: workflow 11).

---

## Datové toky

### CEX Flow (Binance)

```
n8n Cron (4h)
    │
    ▼
Scanner [Binance OHLCV] ──▶ DB (signals)
    │
    ▼
Analyst + MindsDB (opt.) ──▶ DB (signals: analyzed)
    │
    ▼
Risk Controller ──▶ DB (signals: approved)
    │
    ▼
Telegram trade karta ──▶ Uživatel
    │                          │ /approve_ID
    ▼                          ▼
Workflow 03 (chain=cex) ──▶ Workflow 04 Executor ──▶ Binance API
    │
    ▼
DB (trades: open) ──▶ Monitor (15min) ──▶ Binance API
```

### DEX Flow (Solana)

```
n8n Cron (4h)
    │
    ▼
Workflow 09 [Birdeye OHLCV] ──▶ Scanner ──▶ Analyst ──▶ Risk Controller
    │
    ▼
DB (signals, chain='solana')
    │
    ▼
Telegram DEX trade karta ──▶ Uživatel
    │                              │ /approve_ID
    ▼                              ▼
Workflow 03 (chain=solana) ──▶ Workflow 10 DEX Executor
    │                                    │
    │                          Jupiter Quote API
    │                                    │
    │                          Solana Signer mikroservis
    │                                    │
    ▼                          Solana mainnet (tx confirmed)
DB (trades: open, chain='solana')
```

---

## Adresářová struktura

```
algo-trader/
├── services/
│   └── solana-signer/       ← Express mikroservis (signing)
│       ├── index.js
│       ├── package.json
│       └── Dockerfile
├── lib/
│   ├── solana.js            ← Birdeye/Jupiter helpers
│   └── utils.js             ← buildTradeCardMessage
├── workflows/
│   ├── 01_scanner_pipeline.json   ← CEX scanner
│   ├── 03_telegram_handler.json   ← routing CEX/DEX
│   ├── 04_trade_executor.json     ← CEX executor (Binance)
│   ├── 09_dex_scanner.json        ← DEX scanner (Birdeye)
│   └── 10_dex_executor.json       ← DEX executor (Jupiter)
├── db/
│   ├── migrations/
│   │   ├── 001_init.sql           ← základní schéma
│   │   └── 002_dex.sql            ← DEX rozšíření
│   └── seeds/
│       ├── default_config.sql     ← CEX watchlist + portfolio
│       └── dex_watchlist.sql      ← SOL, JUP, RAY, ORCA tokeny
└── tests/
    ├── indicators.test.js
    ├── analyst.test.js
    ├── risk_controller.test.js
    ├── mindsdb.test.js
    └── solana.test.js             ← 47 testů pro lib/solana.js
```

---

## Environment & Deployment

**Docker Compose services:**
- `postgres` — PostgreSQL 16
- `n8n` — orchestrace workflows
- `openclaw` — AI agenti (Scanner, Analyst, Risk Controller)
- `solana-signer` — Solana tx signing (hot wallet)
- `mindsdb` (opt.) — `docker compose --profile mindsdb up -d mindsdb`

**Deployment order:**
1. PostgreSQL + migrations (001, 002)
2. n8n + openclaw + solana-signer
3. Import workflows (01–10)
4. DEX scanner (09) — ověří Birdeye pipeline
5. Telegram notifikace
6. DEX executor (10) — ověří Jupiter + signer
7. MindsDB (až vše jiné běží stabilně)
