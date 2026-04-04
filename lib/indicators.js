'use strict';

/**
 * Calculate Average True Range (ATR) using EMA smoothing (Wilder's method)
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period
 * @returns {number}
 */
function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) {
    throw new Error(`calcATR: need at least ${period + 1} candles, got ${closes.length}`);
  }

  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  // Initial ATR = simple average of first `period` TR values
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder's smoothing for the rest
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }

  return atr;
}

/**
 * Calculate Rate of Change (ROC) for n periods
 * @param {number[]} closes
 * @param {number} period
 * @returns {number} - decimal (0.042 = +4.2%)
 */
function calcROC(closes, period = 12) {
  const n = closes.length;
  if (n < period + 1) {
    throw new Error(`calcROC: need at least ${period + 1} candles, got ${n}`);
  }
  return (closes[n - 1] - closes[n - 1 - period]) / closes[n - 1 - period];
}

/**
 * Calculate Simple Moving Average of last `period` values
 * @param {number[]} values
 * @param {number} period
 * @returns {number}
 */
function calcSMA(values, period) {
  if (values.length < period) {
    throw new Error(`calcSMA: need at least ${period} values, got ${values.length}`);
  }
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Highest high over the last `period` candles, EXCLUDING the current (latest) candle.
 * Matches the strategy spec: breakout when close > hh30 of previous 30 candles.
 * @param {number[]} highs
 * @param {number} period
 * @returns {number}
 */
function calcHighestHigh(highs, period = 30) {
  if (highs.length < period + 1) {
    throw new Error(`calcHighestHigh: need at least ${period + 1} candles`);
  }
  const slice = highs.slice(-period - 1, -1);
  return Math.max(...slice);
}

/**
 * Lowest low over the last `period` candles, EXCLUDING the current (latest) candle.
 * @param {number[]} lows
 * @param {number} period
 * @returns {number}
 */
function calcLowestLow(lows, period = 30) {
  if (lows.length < period + 1) {
    throw new Error(`calcLowestLow: need at least ${period + 1} candles`);
  }
  const slice = lows.slice(-period - 1, -1);
  return Math.min(...slice);
}

/**
 * Compute all indicators needed for the Scanner from an array of candles.
 * @param {Array<{open, high, low, close, volume}>} candles
 * @returns {Object}
 */
function computeIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const n = closes.length;

  const atr14      = calcATR(highs, lows, closes, 14);
  const atr7       = calcATR(highs, lows, closes, 7);
  const hh30       = calcHighestHigh(highs, 30);
  const ll30       = calcLowestLow(lows, 30);
  const roc12      = calcROC(closes, 12);
  const volSma20   = calcSMA(volumes, 20);
  const latestVol  = volumes[n - 1];

  return {
    latest_close:  closes[n - 1],
    latest_high:   highs[n - 1],
    latest_low:    lows[n - 1],
    latest_volume: latestVol,
    atr14,
    atr7,
    hh30,
    ll30,
    roc12,
    vol_sma20:     volSma20,
    volume_ratio:  latestVol / volSma20
  };
}

/**
 * Detect a breakout signal based on computed indicators.
 * Returns a signal object or { is_signal: false }.
 * @param {Object} indicators - Output of computeIndicators()
 * @param {string} symbol     - Exchange symbol e.g. "SOLUSDT"
 * @param {string} displayName - Human-readable e.g. "SOL/USDT"
 * @returns {Object}
 */
function detectBreakout(indicators, symbol, displayName) {
  const {
    latest_close, latest_volume, hh30, ll30,
    roc12, vol_sma20, volume_ratio, atr14, atr7
  } = indicators;

  const base = {
    coin: displayName,
    symbol,
    current_price:   latest_close,
    momentum_roc12:  Math.round(roc12 * 10000) / 10000,
    volume_ratio:    Math.round(volume_ratio * 100) / 100,
    atr14:           Math.round(atr14 * 1e8) / 1e8,
    atr7:            Math.round(atr7 * 1e8) / 1e8,
    timestamp:       new Date().toISOString()
  };

  // LONG breakout
  if (latest_close > hh30 && roc12 > 0.02 && latest_volume > vol_sma20) {
    return {
      is_signal:      true,
      direction:      'long',
      signal_type:    'breakout_high',
      breakout_level: Math.round(hh30 * 1e8) / 1e8,
      ...base
    };
  }

  // SHORT breakout
  if (latest_close < ll30 && roc12 < -0.02 && latest_volume > vol_sma20) {
    return {
      is_signal:      true,
      direction:      'short',
      signal_type:    'breakout_low',
      breakout_level: Math.round(ll30 * 1e8) / 1e8,
      ...base
    };
  }

  return { is_signal: false };
}

/**
 * Parse raw Binance klines API response into structured candle objects.
 * @param {Array} rawKlines - Array of arrays from Binance /api/v3/klines
 * @returns {Array<{timestamp, open, high, low, close, volume}>}
 */
function parseBinanceKlines(rawKlines) {
  return rawKlines.map(c => ({
    timestamp: new Date(c[0]).toISOString(),
    open:      parseFloat(c[1]),
    high:      parseFloat(c[2]),
    low:       parseFloat(c[3]),
    close:     parseFloat(c[4]),
    volume:    parseFloat(c[5])
  }));
}

/**
 * Update trailing stop for an open trade.
 * Returns updated stop info or null if no update needed.
 * @param {Object} trade - Open trade from DB
 * @param {number} currentPrice
 * @param {number} currentAtr14 - Fresh ATR14 for the coin
 * @returns {{ stop_hit, stop_updated, new_stop, action, ... }}
 */
function checkTrailingStop(trade, currentPrice, currentAtr14) {
  const result = {
    trade_id:     trade.id,
    stop_hit:     false,
    stop_updated: false,
    new_stop:     parseFloat(trade.current_stop),
    action:       'none'
  };

  const entryPrice         = parseFloat(trade.entry_price);
  const currentStop        = parseFloat(trade.current_stop);
  const trailAtrMult       = parseFloat(trade.trailing_atr_mult);
  const trailActivationPct = parseFloat(trade.trail_activation_pct);

  if (trade.direction === 'long') {
    if (currentPrice <= currentStop) {
      result.stop_hit   = true;
      result.exit_price = currentStop;
      result.action     = 'close';
      return result;
    }

    const newHigh   = Math.max(parseFloat(trade.highest_since_entry || entryPrice), currentPrice);
    const profitPct = (currentPrice - entryPrice) / entryPrice;

    if (profitPct >= trailActivationPct) {
      const newStop = newHigh - (trailAtrMult * currentAtr14);
      if (newStop > currentStop) {
        result.stop_updated          = true;
        result.new_stop              = Math.round(newStop * 1e8) / 1e8;
        result.highest_since_entry   = newHigh;
        result.action                = 'update_stop';
      }
    }

  } else if (trade.direction === 'short') {
    if (currentPrice >= currentStop) {
      result.stop_hit   = true;
      result.exit_price = currentStop;
      result.action     = 'close';
      return result;
    }

    const newLow    = Math.min(parseFloat(trade.lowest_since_entry || entryPrice), currentPrice);
    const profitPct = (entryPrice - currentPrice) / entryPrice;

    if (profitPct >= trailActivationPct) {
      const newStop = newLow + (trailAtrMult * currentAtr14);
      if (newStop < currentStop) {
        result.stop_updated        = true;
        result.new_stop            = Math.round(newStop * 1e8) / 1e8;
        result.lowest_since_entry  = newLow;
        result.action              = 'update_stop';
      }
    }
  }

  return result;
}

module.exports = {
  calcATR,
  calcROC,
  calcSMA,
  calcHighestHigh,
  calcLowestLow,
  computeIndicators,
  detectBreakout,
  parseBinanceKlines,
  checkTrailingStop
};
