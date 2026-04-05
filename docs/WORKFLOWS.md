# n8n Workflows — Specifikace

## Přehled workflows

| # | Workflow | Trigger | Frekvence | Popis |
|---|---|---|---|---|
| 01 | Scanner Pipeline (CEX) | Cron | Každé 4h | Binance OHLCV → Scanner → Analyst → RC |
| 02 | Telegram Notifier | Webhook | Na event | Pošle trade karty do Telegramu |
| 03 | Telegram Handler | Telegram Trigger | Na zprávu | /approve, /reject, /status — routuje CEX/DEX |
| 04 | Trade Executor (CEX) | Webhook | Na approve | Exekuuje market order na Binance |
| 05 | Position Monitor | Cron | Každých 15 min | Trailing stop management (CEX pozice) |
| 06 | Daily Reset | Cron | Denně 0:00 UTC | Reset denních metrik (portfolio + dex_portfolio) |
| 07 | Monthly Reset | Cron | 1. den měsíce | Reset měsíčních metrik |
| 08 | Error Alert | Webhook | Na error | Pošle error do Telegram error kanálu |
| 09 | DEX Scanner Pipeline | Cron | Každé 4h | Birdeye OHLCV → Scanner → Analyst → RC → Telegram |
| 10 | DEX Trade Executor | Webhook | Na approve | Jupiter quote → sign → broadcast → uložit trade |

---

## Workflow 01: Scanner Pipeline (CEX)

```
[Cron: 0 */4 * * *]
    │
    ▼
[PostgreSQL: SELECT FROM watchlist WHERE is_active = true]  (bez chain filtru = vše)
    │
    ▼
[Loop: pro každý coin]
    │
    ▼
[HTTP Request: Binance OHLCV]
    URL: https://api.binance.com/api/v3/klines?symbol={{coin}}&interval=4h&limit=200
    │
    ▼
[Code: compute_indicators] → {atr14, hh30, ll30, roc12, vol_sma20}
    │
    ▼
[Code: check_breakout] → signal nebo null
    │
    ▼
[IF signal] → [INSERT signals] → [Loop Analyst]
    │
    ▼
[Loop Analyst: Get Portfolio → Query MindsDB → Prepare Input]
    │
    ▼
[Scanner Agent] → [Analyst Agent] → [Risk Controller]
    │
    ▼
[Telegram trade karta (pokud approved)]
```

### Code Node: compute_indicators

```javascript
const candles = $input.all().map(item => item.json);
const closes  = candles.map(c => c.close);
const highs   = candles.map(c => c.high);
const lows    = candles.map(c => c.low);
const volumes = candles.map(c => c.volume);
const n       = closes.length;

function calcATR(highs, lows, closes, period) {
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  let atr = tr.slice(0, period).reduce((a,b) => a+b) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

const hh30     = Math.max(...highs.slice(-31, -1));
const ll30     = Math.min(...lows.slice(-31, -1));
const roc12    = (closes[n-1] - closes[n-13]) / closes[n-13];
const volSma20 = volumes.slice(-20).reduce((a,b) => a+b) / 20;
const atr14    = calcATR(highs, lows, closes, 14);

return [{ json: {
  latest_close: closes[n-1], latest_volume: volumes[n-1],
  atr14, hh30, ll30, roc12,
  vol_sma20: volSma20,
  volume_ratio: volumes[n-1] / volSma20
}}];
```

### Code Node: check_breakout

```javascript
const d = $input.first().json;

let signal = null;

if (d.latest_close > d.hh30 && d.roc12 > 0.02 && d.latest_volume > d.vol_sma20) {
  signal = { direction: 'long', signal_type: 'breakout_high', current_price: d.latest_close,
             breakout_level: d.hh30, momentum_roc12: d.roc12, volume_ratio: d.volume_ratio, atr14: d.atr14,
             latest_volume: d.latest_volume, vol_sma20: d.vol_sma20 };
}

if (!signal && d.latest_close < d.ll30 && d.roc12 < -0.02 && d.latest_volume > d.vol_sma20) {
  signal = { direction: 'short', signal_type: 'breakout_low', current_price: d.latest_close,
             breakout_level: d.ll30, momentum_roc12: d.roc12, volume_ratio: d.volume_ratio, atr14: d.atr14,
             latest_volume: d.latest_volume, vol_sma20: d.vol_sma20 };
}

if (!signal) return [];
return [{ json: { ...signal, symbol: $('Loop Coins').item.json.symbol } }];
```

---

## Workflow 03: Telegram Handler

```
[Telegram Trigger]
    │
    ▼
[Code: Parse & Authorize]
  - Ověří chat_id === TELEGRAM_CHAT_ID
  - Parsuje cmd: approve/reject/status/trades/stop/start
    │
    ▼
[Switch: cmd]
    │
    ├── approve → [DB: UPDATE signals SET status='approved', RETURNING id, symbol, chain]
    │               → [IF chain='solana']
    │                     YES → POST /webhook/dex-execute    (Workflow 10)
    │                     NO  → POST /webhook/telegram-notify (Workflow 04)
    │
    ├── reject  → [DB: UPDATE signals SET status='rejected_by_user']
    │               → [Reply: "❌ Setup zamítnut"]
    │
    ├── status  → [DB: portfolio + open trades]
    │               → [Format & Reply]
    │
    ├── trades  → [DB: last 10 closed trades]
    │               → [Format & Reply]
    │
    ├── stop    → [DB: portfolio SET system_active = false]
    │               → [Reply: "⛔ Systém zastaven"]
    │
    ├── start   → [DB: portfolio SET system_active = true]
    │               → [Reply: "✅ Systém aktivován"]
    │
    └── default → [Reply: "Neznámý příkaz"]
```

---

## Workflow 05: Position Monitor (CEX)

```
[Cron: */15 * * * *]
    │
    ▼
[PostgreSQL: SELECT * FROM trades WHERE status = 'open' AND chain = 'cex']
    │
    ▼
[Loop: pro každý otevřený trade]
    │
    ▼
[HTTP Request: Binance Ticker Price]
    │
    ▼
[Code: check_trailing_stop]
    │
    ├──[stop_hit] ──▶ [Execute Close] → [Update DB] → [Notify]
    ├──[stop_updated] ──▶ [Update DB stop] → [Log]
    └──[no_change] ──▶ [Continue]
```

### Code Node: check_trailing_stop

```javascript
const trade        = $input.first().json.trade;
const currentPrice = parseFloat($input.first().json.ticker.price);

if (trade.direction === 'long') {
  if (currentPrice <= trade.current_stop) {
    return [{ json: { stop_hit: true, exit_price: trade.current_stop, action: 'close' } }];
  }
  const profitPct = (currentPrice - trade.entry_price) / trade.entry_price;
  if (profitPct >= trade.trail_activation_pct) {
    const newHigh = Math.max(trade.highest_since_entry || trade.entry_price, currentPrice);
    const newStop = newHigh - (trade.trailing_atr_mult * trade.current_atr14);
    if (newStop > trade.current_stop) {
      return [{ json: { stop_hit: false, stop_updated: true, new_stop: newStop, action: 'update_stop' } }];
    }
  }
}
// ... short symetrie
return [{ json: { stop_hit: false, stop_updated: false, action: 'none' } }];
```

---

## Workflow 09: DEX Scanner Pipeline (Solana)

**Soubor:** `workflows/09_dex_scanner.json`

```
[Cron: 0 */4 * * *]
    │
    ▼
[PostgreSQL: SELECT FROM dex_portfolio WHERE system_active = true]
    │
    ▼
[PostgreSQL: SELECT w.*, t.decimals, t.liquidity_usd FROM watchlist w
             JOIN dex_tokens t ON t.address = w.token_address
             WHERE w.chain = 'solana' AND w.is_active = true]
    │
    ▼
[Loop Tokens: batchSize=1]
    │
    ├── [HTTP Request: Birdeye OHLCV]
    │     URL: https://public-api.birdeye.so/defi/ohlcv?address={token}&type=4H&...
    │     Headers: X-API-KEY, x-chain: solana
    │
    ├── [Code: Parse Candles] → standardní candle formát + vol_sma20
    │
    ├── [HTTP Request: Scanner Agent (OpenClaw)]
    │
    ├── [Code: Check Breakout] → signal nebo []
    │
    └── [PostgreSQL: INSERT signals (chain='solana')]
    │
    ▼
[Loop Analyst: pro každý nový signal]
    │
    ├── [PostgreSQL: Get DEX Portfolio]
    │
    ├── [HTTP Request: Query MindsDB] (continueOnFail: true)
    │
    ├── [Code: Prepare Analyst Input] → signal + portfolio + mindsdb_prediction
    │
    ├── [HTTP Request: Analyst Agent]
    │
    ├── [Code: Parse Analyst] → trade karta + chain metadata
    │
    ├── [PostgreSQL: UPDATE signals SET status='analyzed']
    │
    ├── [HTTP Request: Risk Controller]
    │
    ├── [Code: Parse RC Decision] → rc_decision: approved/rejected
    │
    ├── [IF approved]
    │     YES → [UPDATE signals SET status='approved']
    │           → [Code: Compose DEX Trade Card]
    │           → [POST Telegram sendMessage]
    │     NO  → [UPDATE signals SET status='rejected']
```

### Klíčový Code Node: Parse Candles

```javascript
const item  = $('Loop Tokens').item.json;
const rawResp = $input.item.json;
const items = rawResp?.data?.items || [];

if (items.length < 50) return [];   // nedostatek dat → přeskočit token

const candles = items.map(c => ({
  timestamp: new Date(c.unixTime * 1000).toISOString(),
  open: parseFloat(c.open), high: parseFloat(c.high),
  low:  parseFloat(c.low),  close: parseFloat(c.close),
  volume: parseFloat(c.volume)
}));

const recentVols = candles.slice(-21, -1).map(c => c.volume);
const volSma20   = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;

return [{ json: { ...item, candles, latest_volume: candles.at(-1)?.volume || 0, vol_sma20 } }];
```

---

## Workflow 10: DEX Trade Executor (Jupiter)

**Soubor:** `workflows/10_dex_executor.json`
**Trigger webhook path:** `/webhook/dex-execute`
**Body:** `{ signal_id: "uuid" }`

```
[Webhook: POST /webhook/dex-execute]
    │
    ▼
[PostgreSQL: GET signal WHERE id=$1 AND status='approved' AND chain='solana']
  (JOIN watchlist + dex_tokens pro token_address, decimals, liquidity_usd)
    │
    ▼
[IF signal found]
    │
    ▼
[PostgreSQL: GET dex_portfolio] (available_usdc)
    │
    ▼
[Code: Calc Position & Slippage]
  - position = min(trade_card.position_size_usdt, available_usdc)
  - slippage = calcDynamicSlippage(position, liquidity_usd)   (30–300 bps)
  - sestaví Jupiter quote URL
    │
    ▼
[HTTP Request: Jupiter GET /v6/quote]
  URL: ?inputMint=USDC&outputMint={token}&amount={lamports}&slippageBps={bps}
    │
    ▼
[Code: Validate Quote]
  - Zkontroluje outAmount existuje
  - priceImpactPct < 3% (jinak throw Error)
  - Vypočítá effectivePrice, outputTokens
    │
    ▼
[HTTP Request: Jupiter POST /v6/swap]
  Body: { quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }
    │
    ▼
[Code: Prepare for Signing]
  - Zkontroluje swapTransaction existuje
    │
    ▼
[HTTP Request: POST http://solana-signer:3001/sign-and-send]
  Body: { swapTransaction: "<base64>" }
    │
    ▼
[IF ok == true]
    │ YES                                    │ NO
    ▼                                        ▼
[Code: Merge Result]                 [Code: Build Error Message]
    │                                        │
    ▼                                        ▼
[PostgreSQL: INSERT trades]          [PostgreSQL: UPDATE signals SET status='failed']
(chain='solana', dex='jupiter',              │
 tx_signature, chain_data JSONB)             ▼
    │                                [HTTP: Telegram error alert]
    ▼
[PostgreSQL: UPDATE dex_portfolio]
(available_usdc -= position, locked += position)
    │
    ▼
[Code: Compose Confirmation]
  "✅ DEX Trade Executed: JUP  |  📝 Solscan link"
    │
    ▼
[HTTP: Telegram sendMessage]
```

### Dynamický slippage (pravidla)

| Poměr pozice / likvidita poolu | Slippage |
|-------------------------------|----------|
| Neznámá likvidita | 200 bps (safe default) |
| < 0.1% | 30 bps |
| 0.1–0.5% | 50 bps |
| 0.5–1% | 100 bps |
| 1–2% | 200 bps |
| > 2% | 300 bps |

---

## Workflow 06: Daily Reset

```
[Cron: 0 0 * * *]
    │
    ▼
[PostgreSQL: UPDATE portfolio SET today_pnl_usdt = 0, today_date = CURRENT_DATE]
[PostgreSQL: UPDATE dex_portfolio SET today_pnl_usdt = 0, today_date = CURRENT_DATE]
    │
    ▼
[Telegram: "📅 Nový den — denní PnL reset"]
```

---

## Workflow 07: Monthly Reset

```
[Cron: 0 0 1 * *]
    │
    ▼
[PostgreSQL: UPDATE portfolio SET month_start_capital = total_value, month_pnl_usdt = 0]
[PostgreSQL: UPDATE dex_portfolio SET month_start_usdc = usdc_balance, month_pnl_usdt = 0]
    │
    ▼
[Telegram: "📊 Nový měsíc — monthly PnL reset. Stop ochrana obnovena."]
```
