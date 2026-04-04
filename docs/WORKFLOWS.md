# n8n Workflows — Specifikace

## Přehled workflows

| # | Workflow | Trigger | Frekvence | Popis |
|---|---|---|---|---|
| 1 | Scanner Pipeline | Cron | Každé 4h | Spustí Scanner → Analyst → Risk Controller |
| 2 | Telegram Notifier | Webhook | Na event | Pošle trade karty do Telegramu |
| 3 | Telegram Handler | Telegram Trigger | Na zprávu | Zpracuje /approve, /reject, /status |
| 4 | Trade Executor | Webhook | Na approve | Exekuuje obchod na Binance |
| 5 | Position Monitor | Cron | Každých 15 min | Trailing stop management |
| 6 | Daily Reset | Cron | Denně 0:00 UTC | Reset denních metrik |
| 7 | Monthly Reset | Cron | 1. den měsíce | Reset měsíčních metrik |
| 8 | Error Alert | Webhook | Na error | Pošle error do Telegram error kanálu |

---

## Workflow 1: Scanner Pipeline

```
[Cron: 0 */4 * * *]
    │
    ▼
[PostgreSQL: SELECT * FROM watchlist WHERE is_active = true]
    │
    ▼
[Loop: pro každý coin]
    │
    ▼
[HTTP Request: Binance OHLCV]
    URL: https://api.binance.com/api/v3/klines
    Query: symbol={{coin.symbol}}&interval=4h&limit=200
    │
    ▼
[Code Node: compute_indicators]
    Vstup: OHLCV pole
    Výstup: {atr14, atr7, hh30, ll30, roc12, vol_sma20, latest_close}
    │
    ▼
[Code Node: check_breakout]
    Vstup: indikátory
    Výstup: {is_signal: bool, direction, signal_data} nebo null
    │
    ▼
[IF: is_signal == true]
    │ YES                          │ NO
    ▼                              ▼
[PostgreSQL: INSERT signal]     [Continue loop]
    │
    ▼
[End Loop]
    │
    ▼
[IF: new signals exist]
    │ YES                          │ NO
    ▼                              ▼
[HTTP Request: POST webhook      [Audit log: "No signals"]
 → Analyst Pipeline]              [END]
```

### Code Node: compute_indicators

```javascript
// Vstup: items = pole OHLCV svíček
const candles = $input.all().map(item => item.json);
const closes = candles.map(c => c.close);
const highs = candles.map(c => c.high);
const lows = candles.map(c => c.low);
const volumes = candles.map(c => c.volume);
const n = closes.length;

// ATR14
function calcATR(highs, lows, closes, period) {
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1])
    ));
  }
  let atr = tr.slice(0, period).reduce((a,b) => a+b) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// Highest High / Lowest Low (30 period)
const hh30 = Math.max(...highs.slice(-31, -1));
const ll30 = Math.min(...lows.slice(-31, -1));

// Rate of Change (12 period)
const roc12 = (closes[n-1] - closes[n-13]) / closes[n-13];

// Volume SMA (20 period)
const volSma20 = volumes.slice(-20).reduce((a,b) => a+b) / 20;

const atr14 = calcATR(highs, lows, closes, 14);
const atr7 = calcATR(highs, lows, closes, 7);

return [{
  json: {
    latest_close: closes[n-1],
    latest_high: highs[n-1],
    latest_low: lows[n-1],
    latest_volume: volumes[n-1],
    atr14, atr7, hh30, ll30, roc12,
    vol_sma20: volSma20,
    volume_ratio: volumes[n-1] / volSma20
  }
}];
```

### Code Node: check_breakout

```javascript
const d = $input.first().json;

let signal = null;

// LONG breakout
if (d.latest_close > d.hh30 && d.roc12 > 0.02 && d.latest_volume > d.vol_sma20) {
  signal = {
    is_signal: true,
    direction: 'long',
    signal_type: 'breakout_high',
    current_price: d.latest_close,
    breakout_level: d.hh30,
    momentum_roc12: Math.round(d.roc12 * 10000) / 10000,
    volume_ratio: Math.round(d.volume_ratio * 100) / 100,
    atr14: d.atr14,
    atr7: d.atr7
  };
}

// SHORT breakout
if (!signal && d.latest_close < d.ll30 && d.roc12 < -0.02 && d.latest_volume > d.vol_sma20) {
  signal = {
    is_signal: true,
    direction: 'short',
    signal_type: 'breakout_low',
    current_price: d.latest_close,
    breakout_level: d.ll30,
    momentum_roc12: Math.round(d.roc12 * 10000) / 10000,
    volume_ratio: Math.round(d.volume_ratio * 100) / 100,
    atr14: d.atr14,
    atr7: d.atr7
  };
}

if (!signal) {
  signal = { is_signal: false };
}

return [{ json: signal }];
```

---

## Workflow 5: Position Monitor

```
[Cron: */15 * * * *]
    │
    ▼
[PostgreSQL: SELECT * FROM trades WHERE status = 'open']
    │
    ▼
[Loop: pro každý otevřený trade]
    │
    ▼
[HTTP Request: Binance Ticker Price]
    URL: https://api.binance.com/api/v3/ticker/price?symbol={{trade.coin}}
    │
    ▼
[Code Node: check_trailing_stop]
    │
    ├──[stop_hit == true]──▶ [Execute Close] → [Update DB] → [Notify]
    │
    ├──[stop_updated == true]──▶ [Update DB stop] → [Log]
    │
    └──[no_change]──▶ [Continue]
```

### Code Node: check_trailing_stop

```javascript
const trade = $input.first().json.trade;
const currentPrice = parseFloat($input.first().json.ticker.price);

let result = {
  trade_id: trade.id,
  stop_hit: false,
  stop_updated: false,
  new_stop: trade.current_stop,
  action: 'none'
};

if (trade.direction === 'long') {
  // Check stop hit
  if (currentPrice <= trade.current_stop) {
    result.stop_hit = true;
    result.exit_price = trade.current_stop;
    result.action = 'close';
    return [{ json: result }];
  }
  
  // Update highest since entry
  const newHigh = Math.max(trade.highest_since_entry || trade.entry_price, currentPrice);
  
  // Check if trailing should activate
  const profitPct = (currentPrice - trade.entry_price) / trade.entry_price;
  
  if (profitPct >= trade.trail_activation_pct) {
    // Fetch current ATR14 (from latest OHLCV)
    const atr14 = trade.current_atr14; // passed from previous node
    const newStop = newHigh - (trade.trailing_atr_mult * atr14);
    
    if (newStop > trade.current_stop) {
      result.stop_updated = true;
      result.new_stop = Math.round(newStop * 100) / 100;
      result.highest_since_entry = newHigh;
      result.action = 'update_stop';
    }
  }
  
} else if (trade.direction === 'short') {
  if (currentPrice >= trade.current_stop) {
    result.stop_hit = true;
    result.exit_price = trade.current_stop;
    result.action = 'close';
    return [{ json: result }];
  }
  
  const newLow = Math.min(trade.lowest_since_entry || trade.entry_price, currentPrice);
  const profitPct = (trade.entry_price - currentPrice) / trade.entry_price;
  
  if (profitPct >= trade.trail_activation_pct) {
    const atr14 = trade.current_atr14;
    const newStop = newLow + (trade.trailing_atr_mult * atr14);
    
    if (newStop < trade.current_stop) {
      result.stop_updated = true;
      result.new_stop = Math.round(newStop * 100) / 100;
      result.lowest_since_entry = newLow;
      result.action = 'update_stop';
    }
  }
}

return [{ json: result }];
```

---

## Workflow 3: Telegram Handler

```
[Telegram Trigger: on message]
    │
    ▼
[Switch: message text]
    │
    ├── /approve_{id} → [Validate signal exists & approved]
    │                     → [POST webhook → Executor]
    │
    ├── /reject_{id}  → [Update signal: rejected_by_user]
    │                     → [Reply: "❌ Setup zamítnut"]
    │
    ├── /status       → [PostgreSQL: portfolio + open trades]
    │                     → [Format & Reply]
    │
    ├── /trades       → [PostgreSQL: last 10 trades]
    │                     → [Format & Reply]
    │
    ├── /stop         → [Update portfolio: system_active = false]
    │                     → [Reply: "⛔ Systém zastaven"]
    │
    ├── /start        → [Update portfolio: system_active = true]
    │                     → [Reply: "✅ Systém aktivován"]
    │
    └── default       → [Reply: "Neznámý příkaz"]
```

### /status Response Format

```
📊 Portfolio Status

💰 Kapitál: $1,042.30
📈 Celkový P&L: +$42.30 (+4.2%)
📅 Dnes: +$12.50 (+1.2%)

📂 Otevřené pozice: 1/3
  🟢 SOL/USDT LONG @ $142.50
     Stop: $138.20 | P&L: +$8.40 (+2.1%)

📊 Win Rate: 58.3% (7W / 5L)
🔴 Consecutive losses: 0
⚡ Systém: AKTIVNÍ
```
