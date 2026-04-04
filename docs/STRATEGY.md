# Obchodní strategie — ATR Trend-Following

## Přehled

Trend-following strategie s ATR-based trailing stop. Vstup na breakoutu, výstup přes dynamický trailing stop, který se přizpůsobuje volatilitě trhu.

## Parametry

| Parametr | Hodnota | Popis |
|---|---|---|
| Timeframe | 4h | Hlavní svíčkový timeframe |
| Breakout lookback | 30 svíček | 5 dnů na 4h timeframe |
| Momentum period | 12 svíček | 2 dny rate of change |
| Momentum threshold | ±2% | Min ROC pro potvrzení breakoutu |
| Volume filter | SMA(20) | Volume musí být nad 20-period průměrem |
| Initial stop | 2.0 × ATR14 | Od entry ceny |
| Max stop distance | 12% | Cap na initial stop |
| Trailing stop | 2.5 × ATR14 | Od nejvyšší ceny od vstupu |
| Trail activation | +4% | Trailing se aktivuje po 4% zisku |
| Take profit | žádný fixní | Řídí trailing stop |
| Risk per trade | 2% kapitálu | Max $20 při $1000 |
| Max position | 45% kapitálu | Max $450 při $1000 |
| Max open | 3 pozice | Souběžně |

## Entry pravidla

### LONG entry
```
close > highest_high(30 svíček, HIGH values)
AND rate_of_change(close, 12 svíček) > +0.02
AND volume > SMA(volume, 20)
```

### SHORT entry
```
close < lowest_low(30 svíček, LOW values)
AND rate_of_change(close, 12 svíček) < -0.02
AND volume > SMA(volume, 20)
```

### Position sizing
```
risk_amount = capital × 0.02
stop_distance = 2.0 × ATR14
risk_per_unit = stop_distance / entry_price
position_size = risk_amount / risk_per_unit
position_size = min(position_size, capital × 0.45)
```

## Exit pravidla

### Trailing stop (primární exit)
```
PO VSTUPU:
  initial_stop = entry - 2.0 × ATR14  (long)
  initial_stop = entry + 2.0 × ATR14  (short)

KAŽDÝ 15 MIN CHECK:
  if unrealized_profit_pct >= 4%:
    trailing_stop = highest_high_since_entry - 2.5 × ATR14  (long)
    trailing_stop = lowest_low_since_entry + 2.5 × ATR14    (short)
    
    new_stop = max(current_stop, trailing_stop)  (long)
    new_stop = min(current_stop, trailing_stop)  (short)
```

### Stop-loss hit
```
if current_price <= stop:  (long)
  → market sell, close trade
  
if current_price >= stop:  (short)  
  → market buy, close trade
```

## Backtestové výsledky

Testováno na 2 rocích simulovaných 4h dat (regime-switching model: bull/bear/chop), 4 coiny, $1000 start.

### Výsledky strategie "ATR Trail" (vítězná varianta)

| Coin | Win Rate | P&L | Profit Factor | Max DD | Trades | Avg Duration |
|---|---|---|---|---|---|---|
| BTC-like | 37.0% | +22.6% | 1.17 | 27.9% | 138 | 1.9d |
| ETH-like | 40.0% | +64.9% | 1.46 | 15.7% | 135 | 2.0d |
| ALGO-like | 41.0% | +79.8% | 1.57 | 21.6% | 139 | 2.1d |
| SOL-like | 48.5% | +169.2% | 1.95 | 9.3% | 132 | 2.1d |
| **Průměr** | **41.6%** | **+84.1%** | **1.54** | **18.6%** | **136** | **2.0d** |

### Porovnání s alternativami

| Strategie | Avg P&L | PF | DD | R:R | Poznámka |
|---|---|---|---|---|---|
| Fixed 9% trail (originál) | +69.8% | 1.56 | 16.2% | 1.77 | Baseline |
| **ATR trail (2.5×)** | **+84.1%** | **1.54** | **18.6%** | **2.12** | **Vítěz** |
| ATR + EMA filtr + partial TP | -2.8% | 0.97 | 14.5% | 2.14 | Přefiltrováno |
| ATR + EMA + ADX + RSI | -10.6% | 0.86 | 18.0% | 2.50 | Přefiltrováno |

### Klíčové závěry

1. Jednoduchost vyhrává — každý přidaný filtr snížil výkon
2. ATR-based stop je lepší než fixní % — adaptuje se na volatilitu
3. Win rate 41% je OK pokud R:R > 2.0 — vyhráváš méně často ale víc
4. Průměrná délka obchodu 2 dny odpovídá swing tradingu
5. Maximální po sobě jdoucí ztráty: 8 — musíš na to být psychicky připravený

## Watchlist (výchozí)

```
BTC/USDT, ETH/USDT, SOL/USDT, ALGO/USDT, AVAX/USDT,
ADA/USDT, DOT/USDT, MATIC/USDT, LINK/USDT, NEAR/USDT
```

## Co strategie NEDĚLÁ

- Nepoužívá fundamentální analýzu
- Nepoužívá sentiment/novinky
- Nepoužívá leverage
- Nepredikuje směr — jen se sveze na trendu, když přijde
- Nefunguje v choppy trzích (to je OK — ztráty jsou řízené)
