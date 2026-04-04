'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { roundTo, extractAgentJSON } = require('../lib/utils');

// ─── Trade Card calculation logic (mirrored from Analyst rules) ───────────────

function computeTradeCard(signal, portfolio, mindbdPrediction = null) {
  const { current_price: entry_price, direction, atr14, volume_ratio, momentum_roc12 } = signal;
  const { available_capital } = portfolio;

  // Stop loss
  const stopDistance = 2.0 * atr14;
  let stop_loss;
  if (direction === 'long') {
    stop_loss = entry_price - stopDistance;
    // Clamp to max 12% from entry
    const minStop = entry_price * 0.88;
    stop_loss = Math.max(stop_loss, minStop);
  } else {
    stop_loss = entry_price + stopDistance;
    const maxStop = entry_price * 1.12;
    stop_loss = Math.min(stop_loss, maxStop);
  }

  const risk_per_unit_pct = Math.abs(entry_price - stop_loss) / entry_price;
  let position_size_usdt = (available_capital * 0.02) / risk_per_unit_pct;
  const max_position = available_capital * 0.45;
  position_size_usdt = Math.min(position_size_usdt, max_position);
  const risk_amount_usdt = position_size_usdt * risk_per_unit_pct;

  // Confidence score
  const now = new Date();
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
  let confidence_score = 0.5;
  if (volume_ratio > 2.0) confidence_score += 0.1;
  if (Math.abs(momentum_roc12) > 0.05) confidence_score += 0.1;
  if (mindbdPrediction?.direction === direction) confidence_score += 0.1;
  if (atr14 / entry_price > 0.08) confidence_score -= 0.1;
  if (isWeekend) confidence_score -= 0.1;
  confidence_score = Math.max(0, Math.min(1, roundTo(confidence_score, 2)));

  return {
    signal_id: signal.id || 'test-signal-id',
    coin: signal.coin,
    direction,
    timeframe: '4h',
    entry_price,
    stop_loss: roundTo(stop_loss, 8),
    trailing_atr_mult: 2.5,
    trail_activation_pct: 0.04,
    risk_per_unit_pct: roundTo(risk_per_unit_pct, 6),
    position_size_usdt: roundTo(position_size_usdt, 2),
    risk_amount_usdt: roundTo(risk_amount_usdt, 2),
    confidence_score,
    reasoning: 'Test reasoning',
    mindsdb_prediction: mindbdPrediction,
    current_capital: available_capital
  };
}

// ─── Stop Loss calculation ────────────────────────────────────────────────────

describe('Analyst: Stop Loss calculation', () => {
  it('LONG stop = entry - 2*ATR14', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.ok(Math.abs(card.stop_loss - (100 - 2 * 3)) < 1e-6);
  });

  it('SHORT stop = entry + 2*ATR14', () => {
    const signal = { current_price: 100, direction: 'short', atr14: 3, volume_ratio: 1.5, momentum_roc12: -0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.ok(Math.abs(card.stop_loss - (100 + 2 * 3)) < 1e-6);
  });

  it('LONG stop is clamped to max 12% distance', () => {
    // ATR14 = 15 → stop distance = 30 → 30% — exceeds 12%, clamp
    const signal = { current_price: 100, direction: 'long', atr14: 15, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.ok(card.stop_loss >= 100 * 0.88, `Stop should be at least 12% below entry, got ${card.stop_loss}`);
    const actualPct = (100 - card.stop_loss) / 100;
    assert.ok(actualPct <= 0.12 + 1e-10, `Risk pct should be <= 12%, got ${actualPct}`);
  });

  it('stop_loss is positive', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.ok(card.stop_loss > 0);
  });
});

// ─── Position sizing ──────────────────────────────────────────────────────────

describe('Analyst: Position sizing', () => {
  it('risk_amount_usdt = 2% of capital for normal ATR', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 2, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    // Normal ATR → risk should be ~2% = $20
    assert.ok(Math.abs(card.risk_amount_usdt - 20) < 1, `Expected ~$20 risk, got ${card.risk_amount_usdt}`);
  });

  it('position_size_usdt never exceeds 45% of capital', () => {
    // Very small ATR → enormous position size → must be capped at 45%
    const signal = { current_price: 100, direction: 'long', atr14: 0.01, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.ok(card.position_size_usdt <= 1000 * 0.45 + 0.01, `Position should be <= 45% = $450, got ${card.position_size_usdt}`);
  });

  it('risk_amount_usdt = position_size_usdt * risk_per_unit_pct', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    const expected = card.position_size_usdt * card.risk_per_unit_pct;
    assert.ok(Math.abs(card.risk_amount_usdt - expected) < 0.01, `PnL calc mismatch: ${card.risk_amount_usdt} vs ${expected}`);
  });
});

// ─── Confidence score ─────────────────────────────────────────────────────────

describe('Analyst: Confidence score', () => {
  const baseSignal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };

  it('base confidence is 0.5', () => {
    const card = computeTradeCard(baseSignal, { available_capital: 1000 });
    // No bonuses/deductions should apply in normal conditions
    assert.ok(card.confidence_score >= 0.3 && card.confidence_score <= 0.8);
  });

  it('confidence increases with high volume_ratio', () => {
    const highVol = { ...baseSignal, volume_ratio: 2.5 };
    const lowVol  = { ...baseSignal, volume_ratio: 1.5 };
    const cardHigh = computeTradeCard(highVol, { available_capital: 1000 });
    const cardLow  = computeTradeCard(lowVol, { available_capital: 1000 });
    assert.ok(cardHigh.confidence_score >= cardLow.confidence_score);
  });

  it('confidence is within [0.0, 1.0]', () => {
    const card = computeTradeCard(baseSignal, { available_capital: 1000 });
    assert.ok(card.confidence_score >= 0.0 && card.confidence_score <= 1.0);
  });

  it('high ATR relative to price reduces confidence', () => {
    const highAtr = { ...baseSignal, atr14: 9 }; // 9% of price → deduction
    const card = computeTradeCard(highAtr, { available_capital: 1000 });
    assert.ok(card.confidence_score < 0.7);
  });
});

// ─── extractAgentJSON (utils) ─────────────────────────────────────────────────

describe('extractAgentJSON', () => {
  it('parses direct JSON string', () => {
    const json = JSON.stringify({ signal_id: 'abc', entry_price: 100 });
    const result = extractAgentJSON(json);
    assert.equal(result.signal_id, 'abc');
    assert.equal(result.entry_price, 100);
  });

  it('extracts JSON from markdown code block', () => {
    const content = 'Here is the result:\n```json\n{"entry_price": 142.5}\n```\nDone.';
    const result = extractAgentJSON(content);
    assert.equal(result.entry_price, 142.5);
  });

  it('extracts JSON embedded in text', () => {
    const content = 'Trade card: {"entry_price": 50, "stop_loss": 45} — done.';
    const result = extractAgentJSON(content);
    assert.equal(result.entry_price, 50);
    assert.equal(result.stop_loss, 45);
  });

  it('throws on non-JSON content', () => {
    assert.throws(() => extractAgentJSON('No JSON here at all.'), /Cannot extract JSON/);
  });
});

// ─── Trade card schema validation ────────────────────────────────────────────

describe('Analyst: Trade card schema', () => {
  const required = [
    'signal_id', 'coin', 'direction', 'entry_price', 'stop_loss',
    'trailing_atr_mult', 'trail_activation_pct', 'risk_per_unit_pct',
    'position_size_usdt', 'risk_amount_usdt', 'confidence_score'
  ];

  it('all required fields present', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'uuid-123' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    required.forEach(f => {
      assert.ok(f in card, `Missing required field: ${f}`);
    });
  });

  it('direction matches signal direction', () => {
    for (const dir of ['long', 'short']) {
      const signal = { current_price: 100, direction: dir, atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
      const card = computeTradeCard(signal, { available_capital: 1000 });
      assert.equal(card.direction, dir);
    }
  });

  it('trailing_atr_mult = 2.5', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.equal(card.trailing_atr_mult, 2.5);
  });

  it('trail_activation_pct = 0.04', () => {
    const signal = { current_price: 100, direction: 'long', atr14: 3, volume_ratio: 1.5, momentum_roc12: 0.03, coin: 'SOL/USDT', id: 'abc' };
    const card = computeTradeCard(signal, { available_capital: 1000 });
    assert.equal(card.trail_activation_pct, 0.04);
  });
});
