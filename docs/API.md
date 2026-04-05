# API Integrace

## Binance API (CEX — pouze offramp)

Binance je v tomto systému používán **jen pro výběr prostředků** (offramp), ne pro primární trading.

### Endpointy

| Endpoint | Metoda | Účel | Workflow |
|---|---|---|---|
| `/api/v3/klines` | GET | OHLCV data | Scanner (CEX) |
| `/api/v3/ticker/price` | GET | Aktuální cena | Monitor |
| `/api/v3/order` | POST | Market order | Executor (CEX) |
| `/api/v3/openOrders` | GET | Otevřené ordery | Monitor |
| `/api/v3/account` | GET | Balance check | Executor (CEX) |

### OHLCV Request

```
GET https://api.binance.com/api/v3/klines
?symbol=SOLUSDT
&interval=4h
&limit=200
```

Response: pole polí `[open_time, open, high, low, close, volume, ...]`

### Market Order

```
POST https://api.binance.com/api/v3/order
Headers: X-MBX-APIKEY: {{BINANCE_API_KEY}}

Body (LONG entry):
{
  "symbol": "SOLUSDT",
  "side": "BUY",
  "type": "MARKET",
  "quoteOrderQty": "390.00",
  "timestamp": {{timestamp}},
  "signature": {{hmac_sha256}}
}
```

### Autentizace

Binance vyžaduje HMAC SHA256 podpis pro trade endpointy.

```javascript
const crypto = require('crypto');
const queryString = `symbol=SOLUSDT&side=BUY&type=MARKET&quoteOrderQty=390&timestamp=${Date.now()}`;
const signature = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET)
  .update(queryString)
  .digest('hex');
```

---

## Birdeye API (DEX — Solana OHLCV)

Hlavní zdroj cenových dat pro Solana tokeny.

**Env:** `BIRDEYE_API_KEY` (zdarma na [birdeye.so/developer](https://birdeye.so/developer))

### OHLCV Request

```
GET https://public-api.birdeye.so/defi/ohlcv
?address={token_address}
&type=4H
&time_from={unix_timestamp}
&time_to={unix_timestamp}

Headers:
  X-API-KEY: {{BIRDEYE_API_KEY}}
  x-chain: solana
```

**Příklad — JUP token, posledních 200 svíček:**
```javascript
// lib/solana.js: buildBirdeyeOHLCVRequest(tokenAddress, '4H', 200)
const now      = Math.floor(Date.now() / 1000);
const timeFrom = now - (200 * 14400);  // 14400 sec = 4h
const url = `https://public-api.birdeye.so/defi/ohlcv?address=${token}&type=4H&time_from=${timeFrom}&time_to=${now}`;
```

**Response:**
```json
{
  "data": {
    "items": [
      { "unixTime": 1700000000, "open": "0.91", "high": "0.95", "low": "0.89", "close": "0.92", "volume": "1250000.5" }
    ]
  }
}
```

### Parsování (lib/solana.js)

```javascript
// parseBirdeyeOHLCV(response) → standardní candle pole
const candles = parseBirdeyeOHLCV(birdeyeResponse);
// [{ timestamp: "2024-...", open: 0.91, high: 0.95, low: 0.89, close: 0.92, volume: 1250000.5 }]
```

### Rate Limits

- Free tier: 100 req/min
- Strategie: 4h cron, 4–6 tokenů = ~6 requestů každé 4h — zanedbatelné

---

## Jupiter API v6 (DEX — Solana swap execution)

Jupiter je agregátor DEX likvidity na Solaně. Nalezne nejlepší route pro swap.

**Base URL:** `https://quote-api.jup.ag/v6`

### 1. Quote — zjisti nejlepší cenu

```
GET /v6/quote
?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   (USDC)
&outputMint={token_address}
&amount={lamports}                   (USDC má 6 decimals: $100 = 100_000_000)
&slippageBps=50                      (0.5%, dynamicky podle likvidity)
&platformFeeBps=0
```

**Response (zkráceno):**
```json
{
  "inputMint": "EPjFWdd...",
  "outputMint": "JUPyiwr...",
  "inAmount": "100000000",
  "outAmount": "108695652",
  "priceImpactPct": "0.05",
  "slippageBps": 50,
  "routePlan": [{"swapInfo": {"label": "Raydium"}}]
}
```

### 2. Swap transaction — sestav transakci

```
POST /v6/swap
Content-Type: application/json

{
  "quoteResponse": { <quote z předchozího kroku> },
  "userPublicKey": "vaše_solana_adresa",
  "wrapAndUnwrapSol": true,
  "dynamicComputeUnitLimit": true,
  "prioritizationFeeLamports": "auto"
}
```

**Response:**
```json
{
  "swapTransaction": "<base64 VersionedTransaction>",
  "lastValidBlockHeight": 123456
}
```

### 3. Dynamický slippage (lib/solana.js)

```javascript
// calcDynamicSlippage(positionUsdt, liquidityUsdt) → bps
// < 0.1% pool: 30 bps
// 0.1–0.5%:    50 bps
// 0.5–1%:      100 bps
// 1–2%:        200 bps
// > 2%:        300 bps
// neznámá liq: 200 bps (safe default)
```

---

## Solana Signer Mikroservis

Separátní Express.js service, který drží private key a podepisuje transakce.
**Nikdy nevolej přímo z n8n Code Node** — n8n nemůže importovat `@solana/web3.js`.

**Base URL (Docker internal):** `http://solana-signer:3001`

### GET /health

```json
{ "ok": true, "wallet": "base58_pubkey", "rpc": "https://...", "timestamp": "..." }
```

### GET /balance

```json
{ "ok": true, "sol": 0.12, "usdc": 195.50, "wallet": "base58_pubkey" }
```

### POST /sign-and-send

```
POST http://solana-signer:3001/sign-and-send
Content-Type: application/json

{
  "swapTransaction": "<base64 z Jupiter /v6/swap>"
}
```

**Úspěšná response:**
```json
{
  "ok": true,
  "signature": "5Kq2...",
  "explorerUrl": "https://solscan.io/tx/5Kq2..."
}
```

**Chybová response:**
```json
{
  "ok": false,
  "error": "Transaction failed on-chain",
  "signature": "5Kq2...",
  "txError": "..."
}
```

### Interní flow (Workflow 10)

```
n8n → Jupiter Quote → Jupiter Swap → POST /sign-and-send → Solana mainnet
```

---

## Telegram Bot API

### Setup

1. Napsat @BotFather na Telegramu
2. `/newbot` → zadat jméno → dostat TOKEN
3. Zjistit chat_id: `https://api.telegram.org/bot<TOKEN>/getUpdates` po odeslání zprávy botu

### Odesílání zpráv (n8n HTTP Request)

```
POST https://api.telegram.org/bot{{TOKEN}}/sendMessage
{
  "chat_id": "{{CHAT_ID}}",
  "text": "⚡ DEX Signal: JUP/USDC\n...",
  "parse_mode": "Markdown"
}
```

### DEX trade karta (formát)

```
📈 DEX Signal: Jupiter (JUP)
⚡ Solana DEX

Směr: LONG
Vstup: `0.9200`
SL: `0.8500`  |  TP: `1.0500`
Pozice: $40.00  |  R:R 1.85
Likvidita poolu: $2400k  |  Slippage: 50bps
Konfidenční skóre: 72%
🤖 MindsDB: bullish, +8.5% predikce

Token: `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`
Signal ID: abc-123

/approve_abc-123 | /reject_abc-123
```

---

## MindsDB (volitelné — Fáze 2)

### Spuštění

```bash
docker compose --profile mindsdb up -d mindsdb
```

### Setup prediktivního modelu

Viz `scripts/setup_mindsdb.sql`. Stručně:

```sql
-- 1. Propoj s PostgreSQL
CREATE DATABASE algotrader_db WITH ENGINE = 'postgres', PARAMETERS = {...};

-- 2. Training view
CREATE VIEW mindsdb.training_data AS SELECT ... FROM algotrader_db.signals ...;

-- 3. Vytvoř model
CREATE MODEL price_predictor
PREDICT direction
USING engine = 'lightwood',
      input_columns = ['close', 'volume', 'atr14', 'roc12', 'volume_ratio'],
      horizon = 6;
```

### Query predikce (n8n HTTP Request)

```
POST http://mindsdb:47334/api/sql/query
{
  "query": "SELECT direction, confidence, predicted_move_pct FROM mindsdb.price_predictor WHERE close = 0.92 AND volume = 1250000 AND atr14 = 0.05 AND roc12 = 0.042 AND volume_ratio = 1.8"
}
```

**Response:**
```json
{
  "data": [{"direction": "bullish", "confidence": 0.72, "predicted_move_pct": 8.5}]
}
```

**Graceful degradation:** Workflow 09 používá `continueOnFail: true` — pokud MindsDB není dostupné nebo model není natrénovaný, analyst pipeline pokračuje s `mindsdb_prediction: null`.
