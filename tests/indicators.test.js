'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calcATR, calcROC, calcSMA,
  calcHighestHigh, calcLowestLow,
  computeIndicators, detectBreakout, parseBinanceKlines
} = require('../lib/indicators');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandles(n, baseClose = 100, baseHigh = 105, baseLow = 95, baseVol = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(Date.now() - (n - i) * 4 * 3600 * 1000).toISOString(),
    open:   baseClose,
    high:   baseHigh + i * 0.01,
    low:    baseLow  - i * 0.01,
    close:  baseClose + i * 0.05,
    volume: baseVol
  }));
}

// ─── calcATR ─────────────────────────────────────────────────────────────────

describe('calcATR', () => {
  it('returns a positive number for valid candles', () => {
    const candles = makeCandles(50);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const atr = calcATR(highs, lows, closes, 14);
    assert.ok(atr > 0, 'ATR should be positive');
    assert.ok(isFinite(atr), 'ATR should be finite');
  });

  it('throws when not enough candles', () => {
    assert.throws(() => calcATR([1], [1], [1], 14), /need at least/);
  });

  it('ATR14 > ATR7 is not always true but both should be positive', () => {
    const candles = makeCandles(100);
    const h = candles.map(c => c.high);
    const l = candles.map(c => c.low);
    const c = candles.map(c => c.close);
    const atr14 = calcATR(h, l, c, 14);
    const atr7  = calcATR(h, l, c, 7);
    assert.ok(atr14 > 0);
    assert.ok(atr7  > 0);
  });
});

// ─── calcROC ─────────────────────────────────────────────────────────────────

describe('calcROC', () => {
  it('returns correct ROC for known values', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    // closes[19]=119, closes[7]=107 → ROC12 = (119-107)/107 ≈ 0.1121
    const roc = calcROC(closes, 12);
    assert.ok(Math.abs(roc - (119 - 107) / 107) < 1e-10);
  });

  it('positive ROC for rising prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    assert.ok(calcROC(closes, 12) > 0);
  });

  it('negative ROC for falling prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
    assert.ok(calcROC(closes, 12) < 0);
  });

  it('throws when not enough closes', () => {
    assert.throws(() => calcROC([100, 101], 12), /need at least/);
  });
});

// ─── calcSMA ─────────────────────────────────────────────────────────────────

describe('calcSMA', () => {
  it('calculates correct SMA', () => {
    const values = [10, 20, 30, 40, 50];
    assert.equal(calcSMA(values, 5), 30);
  });

  it('uses only last period values', () => {
    const values = [1, 2, 3, 100, 200, 300];
    const sma = calcSMA(values, 3);
    assert.ok(Math.abs(sma - 200) < 1e-10);
  });

  it('throws when not enough values', () => {
    assert.throws(() => calcSMA([1, 2], 5), /need at least/);
  });
});

// ─── calcHighestHigh / calcLowestLow ─────────────────────────────────────────

describe('calcHighestHigh', () => {
  it('returns max of previous 30 candles (excluding last)', () => {
    const highs = Array.from({ length: 35 }, (_, i) => i + 1);
    // highs = [1, 2, ..., 35]
    // slice(-31, -1) = [5, 6, ..., 34] → max = 34
    const hh = calcHighestHigh(highs, 30);
    assert.equal(hh, 34);
  });

  it('throws when not enough candles', () => {
    assert.throws(() => calcHighestHigh([1, 2], 30), /need at least/);
  });
});

describe('calcLowestLow', () => {
  it('returns min of previous 30 candles (excluding last)', () => {
    const lows = Array.from({ length: 35 }, (_, i) => 100 - i);
    // lows = [100, 99, ..., 66]
    // slice(-31, -1) = [69, 68, ..., 67, 66] → min = 66
    const ll = calcLowestLow(lows, 30);
    assert.equal(ll, 66);
  });
});

// ─── computeIndicators ───────────────────────────────────────────────────────

describe('computeIndicators', () => {
  it('returns all required fields', () => {
    const candles = makeCandles(100);
    const result = computeIndicators(candles);

    const required = ['latest_close', 'latest_high', 'latest_low', 'latest_volume',
                      'atr14', 'atr7', 'hh30', 'll30', 'roc12', 'vol_sma20', 'volume_ratio'];
    for (const key of required) {
      assert.ok(key in result, `Missing key: ${key}`);
      assert.ok(isFinite(result[key]), `${key} should be finite number, got ${result[key]}`);
    }
  });

  it('volume_ratio is volume / vol_sma20', () => {
    const candles = makeCandles(100, 100, 105, 95, 1000);
    const result = computeIndicators(candles);
    assert.ok(Math.abs(result.volume_ratio - result.latest_volume / result.vol_sma20) < 1e-10);
  });
});

// ─── detectBreakout ──────────────────────────────────────────────────────────

describe('detectBreakout', () => {
  function makeIndicators(overrides = {}) {
    return {
      latest_close: 100,
      latest_high: 105,
      latest_low: 95,
      latest_volume: 2000,
      atr14: 5,
      atr7: 4,
      hh30: 98,      // below latest_close → breakout
      ll30: 80,
      roc12: 0.03,   // > 0.02 → momentum ok
      vol_sma20: 1000,
      volume_ratio: 2.0,
      ...overrides
    };
  }

  it('detects LONG breakout', () => {
    const ind = makeIndicators();
    const result = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');
    assert.equal(result.is_signal, true);
    assert.equal(result.direction, 'long');
    assert.equal(result.signal_type, 'breakout_high');
    assert.equal(result.coin, 'SOL/USDT');
  });

  it('detects SHORT breakout', () => {
    const ind = makeIndicators({
      latest_close: 70,
      ll30: 75,       // above latest_close → breakout down
      hh30: 98,
      roc12: -0.03
    });
    const result = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');
    assert.equal(result.is_signal, true);
    assert.equal(result.direction, 'short');
  });

  it('no signal when momentum insufficient', () => {
    const ind = makeIndicators({ roc12: 0.01 }); // < 0.02
    const result = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');
    assert.equal(result.is_signal, false);
  });

  it('no signal when volume insufficient', () => {
    const ind = makeIndicators({ latest_volume: 500 }); // < vol_sma20=1000
    const result = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');
    assert.equal(result.is_signal, false);
  });

  it('no signal when price below hh30', () => {
    const ind = makeIndicators({ latest_close: 97 }); // < hh30=98
    const result = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');
    assert.equal(result.is_signal, false);
  });
});

// ─── parseBinanceKlines ───────────────────────────────────────────────────────

describe('parseBinanceKlines', () => {
  it('parses Binance kline arrays correctly', () => {
    const raw = [
      [1700000000000, '100.0', '105.5', '98.2', '103.1', '5000', 0, 0, 0, 0, 0, 0]
    ];
    const candles = parseBinanceKlines(raw);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].open, 100.0);
    assert.equal(candles[0].high, 105.5);
    assert.equal(candles[0].low, 98.2);
    assert.equal(candles[0].close, 103.1);
    assert.equal(candles[0].volume, 5000);
    assert.ok(typeof candles[0].timestamp === 'string');
  });
});
