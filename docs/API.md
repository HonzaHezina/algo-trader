# API Integrace

## Binance API

### Endpointy

| Endpoint | Metoda | Účel | Workflow |
|---|---|---|---|
| `/api/v3/klines` | GET | OHLCV data | Scanner |
| `/api/v3/ticker/price` | GET | Aktuální cena | Monitor |
| `/api/v3/order` | POST | Market order | Executor |
| `/api/v3/openOrders` | GET | Otevřené ordery | Monitor |
| `/api/v3/account` | GET | Balance check | Executor |

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

Body (LONG exit / market sell):
{
  "symbol": "SOLUSDT",
  "side": "SELL",
  "type": "MARKET",
  "quantity": "2.7368",
  "timestamp": {{timestamp}},
  "signature": {{hmac_sha256}}
}
```

### Autentizace

Binance vyžaduje HMAC SHA256 podpis pro trade endpointy.

```javascript
// n8n Code Node — sign request
const crypto = require('crypto');
const queryString = `symbol=SOLUSDT&side=BUY&type=MARKET&quoteOrderQty=390&timestamp=${Date.now()}`;
const signature = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET)
  .update(queryString)
  .digest('hex');
```

### Rate Limits

- Weight limit: 1200/min (OHLCV = 1 weight, ticker = 1 weight)
- Order limit: 10 orders/sec, 100,000/day
- Scanner (10 coinů × 1 request = 10 weight každé 4h) — zanedbatelné

---

## CoinGecko API (fallback / doplněk)

Pro případ, že Binance API není dostupné nebo pro doplňková data.

```
GET https://api.coingecko.com/api/v3/coins/{id}/market_chart
?vs_currency=usd
&days=30
&interval=daily
```

Free tier: 10-30 calls/min. Pro tento systém dostatečné.

---

## Telegram Bot API

### Setup

1. Napsat @BotFather na Telegramu
2. `/newbot` → zadat jméno → dostat TOKEN
3. Zjistit chat_id: `https://api.telegram.org/bot<TOKEN>/getUpdates` po odeslání zprávy botu

### Odesílání zpráv (n8n Telegram node)

```
POST https://api.telegram.org/bot{{TOKEN}}/sendMessage
{
  "chat_id": "{{CHAT_ID}}",
  "text": "🟢 LONG Setup — SOL/USDT\n...",
  "parse_mode": "Markdown",
  "reply_markup": {
    "inline_keyboard": [[
      {"text": "✅ Approve", "callback_data": "approve_{{signal_id}}"},
      {"text": "❌ Reject", "callback_data": "reject_{{signal_id}}"}
    ]]
  }
}
```

### Callback handling (n8n Telegram Trigger)

n8n Telegram Trigger node automaticky zachytí callback_data z inline tlačítek.

---

## MindsDB (volitelné)

### Setup prediktivního modelu

```sql
-- Vytvoř ML model nad historickými daty
CREATE MODEL price_predictor
PREDICT direction
USING
  engine = 'lightwood',
  input_columns = ['close', 'volume', 'atr14', 'roc12', 'volume_ratio'],
  window = 30,
  horizon = 6;  -- predikce na 6 svíček = 24h

-- Query predikce
SELECT direction, confidence
FROM price_predictor
WHERE close = 142.50
  AND volume = 2500000
  AND atr14 = 3.65
  AND roc12 = 0.042
  AND volume_ratio = 1.8;
```

### Integrace v n8n

HTTP Request node na MindsDB REST API:
```
POST http://{{MINDSDB_HOST}}:{{MINDSDB_PORT}}/api/sql/query
{
  "query": "SELECT direction, confidence FROM price_predictor WHERE ..."
}
```
