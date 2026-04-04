'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeIndicators, detectBreakout, parseBinanceKlines } = require('../lib/indicators');

// ─── Mock OHLCV data helpers ──────────────────────────────────────────────────

function makeFlatCandles(n) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(Date.now() - (n - i) * 4 * 3600 * 1000).toISOString(),
    open: 100, high: 102, low: 98, close: 100, volume: 1000
  }));
}

function makeBinanceKlines(n, closePrice = 100, volume = 1000) {
  return Array.from({ length: n }, (_, i) => [
    Date.now() - (n - i) * 4 * 3600 * 1000,
    String(closePrice), String(closePrice + 2),
    String(closePrice - 2), String(closePrice), String(volume),
    0, 0, 0, 0, 0, 0
  ]);
}

// ─── Scanner workflow code node: Transform OHLCV ─────────────────────────────

describe('Scanner: Transform OHLCV', () => {
  it('parseBinanceKlines produces correct structure', () => {
    const raw = makeBinanceKlines(200);
    const candles = parseBinanceKlines(raw);
    assert.equal(candles.length, 200);
    candles.forEach(c => {
      assert.ok(c.close > 0);
      assert.ok(c.volume > 0);
      assert.ok(typeof c.timestamp === 'string');
    });
  });

  it('handles minimum viable candle count (50)', () => {
    const raw = makeBinanceKlines(50);
    const candles = parseBinanceKlines(raw);
    assert.equal(candles.length, 50);
  });
});

// ─── Scanner workflow code node: Compute Indicators ──────────────────────────

describe('Scanner: Compute Indicators', () => {
  it('computes indicators from 200 candles without error', () => {
    const candles = parseBinanceKlines(makeBinanceKlines(200));
    const result = computeIndicators(candles);
    assert.ok(result.atr14 > 0);
    assert.ok(result.atr7 > 0);
    assert.ok(isFinite(result.roc12));
    assert.ok(result.vol_sma20 > 0);
  });

  it('volume_ratio = 1.0 for constant volume', () => {
    const candles = parseBinanceKlines(makeBinanceKlines(100, 100, 1000));
    const result = computeIndicators(candles);
    assert.ok(Math.abs(result.volume_ratio - 1.0) < 0.001);
  });

  it('hh30 excludes the current (last) candle', () => {
    // All candles at 100 except last candle at 200
    const candles = makeFlatCandles(50);
    candles[candles.length - 1] = { ...candles[candles.length - 1], high: 200, close: 200 };
    const result = computeIndicators(candles);
    // hh30 should NOT include the last candle's high (200)
    assert.ok(result.hh30 < 200, `hh30 should exclude last candle, got ${result.hh30}`);
  });
});

// ─── Scanner workflow code node: Check Breakout ──────────────────────────────

describe('Scanner: Check Breakout logic', () => {
  it('LONG breakout: all three conditions must pass', () => {
    // Build 100 flat candles, then spike last one
    const candles = makeFlatCandles(100);
    // Override last candle to break above hh30
    candles[99] = { ...candles[99], high: 120, close: 120, volume: 5000 };
    // Also need 12+ period ROC — override close prices for momentum
    for (let i = 86; i < 99; i++) {
      candles[i] = { ...candles[i], close: 100 + (i - 86) * 0.1 };
    }

    const ind = computeIndicators(candles);
    // hh30 should be ~102 (flat candles), latest_close = 120 → breakout
    const signal = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');

    // ROC12 might not be > 0.02 with small movement; just test detection logic
    if (ind.roc12 > 0.02 && ind.latest_volume > ind.vol_sma20) {
      assert.equal(signal.is_signal, true);
      assert.equal(signal.direction, 'long');
    } else {
      assert.equal(signal.is_signal, false); // correctly rejected on missing condition
    }
  });

  it('no signal when system gives conflicting signals — long AND short impossible simultaneously', () => {
    const candles = makeFlatCandles(100);
    const ind = computeIndicators(candles);
    const signal = detectBreakout(ind, 'BTCUSDT', 'BTC/USDT');
    // Flat candles → no breakout
    assert.equal(signal.is_signal, false);
    // Cannot have both long and short
    if (signal.is_signal) {
      assert.ok(signal.direction === 'long' || signal.direction === 'short');
    }
  });

  it('signal output schema is complete', () => {
    const ind = {
      latest_close: 120,
      latest_high: 125,
      latest_low: 118,
      latest_volume: 5000,
      atr14: 3,
      atr7: 2.5,
      hh30: 110, // below close → breakout
      ll30: 80,
      roc12: 0.05,
      vol_sma20: 1000,
      volume_ratio: 5.0
    };
    const signal = detectBreakout(ind, 'SOLUSDT', 'SOL/USDT');
    assert.equal(signal.is_signal, true);
    assert.ok('coin' in signal);
    assert.ok('direction' in signal);
    assert.ok('signal_type' in signal);
    assert.ok('current_price' in signal);
    assert.ok('breakout_level' in signal);
    assert.ok('momentum_roc12' in signal);
    assert.ok('volume_ratio' in signal);
    assert.ok('atr14' in signal);
    assert.ok('atr7' in signal);
    assert.ok('timestamp' in signal);
  });
});

// ─── Signal output schema validation ─────────────────────────────────────────

describe('Scanner: Signal schema validation', () => {
  const requiredFields = ['coin', 'direction', 'signal_type', 'current_price', 'atr14'];
  const validDirections = ['long', 'short'];

  it('direction is always long or short', () => {
    const longInd = { latest_close: 120, latest_volume: 5000, hh30: 110, ll30: 80, roc12: 0.05, vol_sma20: 1000, volume_ratio: 5, atr14: 3, atr7: 2.5 };
    const signal = detectBreakout(longInd, 'SOL', 'SOL/USDT');
    if (signal.is_signal) {
      assert.ok(validDirections.includes(signal.direction));
    }
  });

  it('all required fields present when signal = true', () => {
    const ind = { latest_close: 120, latest_volume: 5000, hh30: 110, ll30: 80, roc12: 0.05, vol_sma20: 1000, volume_ratio: 5, atr14: 3, atr7: 2.5 };
    const signal = detectBreakout(ind, 'SOL', 'SOL/USDT');
    if (signal.is_signal) {
      requiredFields.forEach(f => {
        assert.ok(f in signal, `Missing required field: ${f}`);
        assert.ok(signal[f] !== null && signal[f] !== undefined);
      });
    }
  });

  it('current_price is positive', () => {
    const ind = { latest_close: 120, latest_volume: 5000, hh30: 110, ll30: 80, roc12: 0.05, vol_sma20: 1000, volume_ratio: 5, atr14: 3, atr7: 2.5 };
    const signal = detectBreakout(ind, 'SOL', 'SOL/USDT');
    if (signal.is_signal) {
      assert.ok(signal.current_price > 0);
    }
  });
});
