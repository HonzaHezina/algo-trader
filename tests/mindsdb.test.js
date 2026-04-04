'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── MindsDB integration helpers (mirrored from workflow logic) ───────────────

/**
 * Parse MindsDB REST API response and extract prediction.
 * Returns prediction object or null if MindsDB unavailable / no data.
 */
function parseMindsDbResponse(apiResponse) {
  if (!apiResponse || apiResponse.error) return null;
  if (!apiResponse.data || apiResponse.data.length === 0) return null;

  const row = apiResponse.data[0];
  if (!row || !row.direction) return null;

  return {
    direction: row.direction,
    confidence: row.confidence != null ? parseFloat(row.confidence) : null,
    predicted_move_pct: row.predicted_move_pct != null ? parseFloat(row.predicted_move_pct) : null
  };
}

/**
 * Build MindsDB SQL query from signal data.
 * Returns the SQL string to send to MindsDB REST API.
 */
function buildMindsDbQuery(signalData) {
  const close     = signalData.current_price || 0;
  const volume    = signalData.latest_volume || 0;
  const atr14     = signalData.atr14 || 1;
  const roc12     = signalData.momentum_roc12 || 0;
  const volRatio  = signalData.volume_ratio || 1;

  return `SELECT direction, confidence, predicted_move_pct FROM mindsdb.price_predictor WHERE close = ${close} AND volume = ${volume} AND atr14 = ${atr14} AND roc12 = ${roc12} AND volume_ratio = ${volRatio} LIMIT 1`;
}

/**
 * Check if the MindsDB prediction agrees with the signal direction.
 * Used by Analyst SOUL.md for confidence score +0.1 bonus.
 */
function predictionsAgree(signalDirection, prediction) {
  if (!prediction || !prediction.direction) return false;
  if (signalDirection === 'long'  && prediction.direction === 'bullish') return true;
  if (signalDirection === 'short' && prediction.direction === 'bearish') return true;
  return false;
}

// ─── parseMindsDbResponse ──────────────────────────────────────────────────────

describe('parseMindsDbResponse: valid responses', () => {
  it('parses bullish prediction with confidence', () => {
    const response = {
      data: [{
        direction: 'bullish',
        confidence: '0.72',
        predicted_move_pct: '8.5'
      }]
    };
    const result = parseMindsDbResponse(response);
    assert.equal(result.direction, 'bullish');
    assert.equal(result.confidence, 0.72);
    assert.equal(result.predicted_move_pct, 8.5);
  });

  it('parses bearish prediction', () => {
    const response = {
      data: [{
        direction: 'bearish',
        confidence: '0.65',
        predicted_move_pct: '-5.2'
      }]
    };
    const result = parseMindsDbResponse(response);
    assert.equal(result.direction, 'bearish');
    assert.equal(result.predicted_move_pct, -5.2);
  });

  it('handles missing predicted_move_pct (null)', () => {
    const response = {
      data: [{ direction: 'bullish', confidence: '0.5', predicted_move_pct: null }]
    };
    const result = parseMindsDbResponse(response);
    assert.equal(result.predicted_move_pct, null);
  });

  it('returns numeric confidence (not string)', () => {
    const response = {
      data: [{ direction: 'bullish', confidence: '0.80', predicted_move_pct: '3.2' }]
    };
    const result = parseMindsDbResponse(response);
    assert.ok(typeof result.confidence === 'number');
    assert.ok(typeof result.predicted_move_pct === 'number');
  });
});

describe('parseMindsDbResponse: degradation / unavailability', () => {
  it('returns null when response is null', () => {
    assert.equal(parseMindsDbResponse(null), null);
  });

  it('returns null when response has error field', () => {
    assert.equal(parseMindsDbResponse({ error: 'model not found' }), null);
  });

  it('returns null when data array is empty (no training yet)', () => {
    assert.equal(parseMindsDbResponse({ data: [] }), null);
  });

  it('returns null when direction is missing (model returned partial data)', () => {
    const response = { data: [{ confidence: '0.5' }] };
    assert.equal(parseMindsDbResponse(response), null);
  });

  it('returns null when data is undefined', () => {
    assert.equal(parseMindsDbResponse({}), null);
  });
});

// ─── buildMindsDbQuery ────────────────────────────────────────────────────────

describe('buildMindsDbQuery: SQL query construction', () => {
  it('builds correct SELECT query from signal data', () => {
    const signalData = {
      current_price: 142.50,
      latest_volume: 2500000,
      atr14: 3.65,
      momentum_roc12: 0.042,
      volume_ratio: 1.8
    };
    const query = buildMindsDbQuery(signalData);
    assert.ok(query.startsWith('SELECT direction, confidence, predicted_move_pct FROM mindsdb.price_predictor'));
    assert.ok(query.includes('close = 142.5'));
    assert.ok(query.includes('volume = 2500000'));
    assert.ok(query.includes('atr14 = 3.65'));
    assert.ok(query.includes('roc12 = 0.042'));
    assert.ok(query.includes('volume_ratio = 1.8'));
    assert.ok(query.includes('LIMIT 1'));
  });

  it('uses safe defaults for missing fields', () => {
    const query = buildMindsDbQuery({});
    assert.ok(query.includes('close = 0'));
    assert.ok(query.includes('volume = 0'));
    assert.ok(query.includes('atr14 = 1'));  // avoid div by zero
    assert.ok(query.includes('roc12 = 0'));
    assert.ok(query.includes('volume_ratio = 1'));
  });

  it('contains no SQL injection risk from numeric inputs', () => {
    const signalData = {
      current_price: 100,
      latest_volume: 1000,
      atr14: 2.5,
      momentum_roc12: 0.03,
      volume_ratio: 1.5
    };
    const query = buildMindsDbQuery(signalData);
    // All inputs are numbers — no string interpolation of untrusted input
    assert.ok(!query.includes("'"));
    assert.ok(!query.includes('"'));
  });
});

// ─── predictionsAgree ────────────────────────────────────────────────────────

describe('predictionsAgree: confidence score bonus logic', () => {
  it('LONG + bullish = agree', () => {
    assert.equal(predictionsAgree('long', { direction: 'bullish' }), true);
  });

  it('SHORT + bearish = agree', () => {
    assert.equal(predictionsAgree('short', { direction: 'bearish' }), true);
  });

  it('LONG + bearish = disagree', () => {
    assert.equal(predictionsAgree('long', { direction: 'bearish' }), false);
  });

  it('SHORT + bullish = disagree', () => {
    assert.equal(predictionsAgree('short', { direction: 'bullish' }), false);
  });

  it('returns false when prediction is null', () => {
    assert.equal(predictionsAgree('long', null), false);
  });

  it('returns false when prediction has no direction', () => {
    assert.equal(predictionsAgree('long', { confidence: 0.7 }), false);
  });
});

// ─── Confidence score with MindsDB ───────────────────────────────────────────

describe('Analyst confidence score with MindsDB bonus', () => {
  function calcConfidence(indicators, signalDirection, prediction) {
    let score = 0.5;
    if (indicators.volume_ratio > 2.0) score += 0.1;
    if (Math.abs(indicators.momentum_roc12) > 0.05) score += 0.1;
    if (predictionsAgree(signalDirection, prediction)) score += 0.1;
    if ((indicators.atr14 / indicators.current_price) > 0.08) score -= 0.1;
    return Math.max(0, Math.min(1, parseFloat(score.toFixed(2))));
  }

  it('no bonus when MindsDB prediction is null', () => {
    const ind = { volume_ratio: 1.5, momentum_roc12: 0.03, atr14: 3, current_price: 100 };
    const score = calcConfidence(ind, 'long', null);
    assert.equal(score, 0.5);
  });

  it('+0.1 bonus when MindsDB agrees with signal direction', () => {
    const ind = { volume_ratio: 1.5, momentum_roc12: 0.03, atr14: 3, current_price: 100 };
    const pred = { direction: 'bullish', confidence: 0.7, predicted_move_pct: 5 };
    const score = calcConfidence(ind, 'long', pred);
    assert.equal(score, 0.6);
  });

  it('no bonus when MindsDB disagrees with signal direction', () => {
    const ind = { volume_ratio: 1.5, momentum_roc12: 0.03, atr14: 3, current_price: 100 };
    const pred = { direction: 'bearish', confidence: 0.6, predicted_move_pct: -3 };
    const score = calcConfidence(ind, 'long', pred);
    assert.equal(score, 0.5);
  });

  it('score stays within [0.0, 1.0] with all bonuses', () => {
    const ind = { volume_ratio: 3.0, momentum_roc12: 0.07, atr14: 3, current_price: 100 };
    const pred = { direction: 'bullish', confidence: 0.9, predicted_move_pct: 10 };
    const score = calcConfidence(ind, 'long', pred);
    assert.ok(score >= 0 && score <= 1);
    assert.equal(score, 0.8); // 0.5 + 0.1 (volume) + 0.1 (momentum) + 0.1 (mindsdb)
  });
});
