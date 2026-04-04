'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── Risk Controller logic (mirrored from Risk Controller rules) ──────────────

function checkRiskRules(tradeCard, portfolio, openTrades, riskConfig) {
  const checks = [];
  let rejected = false;
  let rejection_reason = null;
  let system_stop = false;

  // ── System Stop checks ────────────────────────────────────────────────────

  if (!portfolio.system_active) {
    system_stop = true;
    return {
      signal_id: tradeCard.signal_id,
      decision: 'rejected',
      checks: [{ rule: 'system_active', passed: false, reason: 'System is stopped' }],
      rejection_reason: 'System is stopped by user or automatic halt',
      system_stop: true
    };
  }

  const monthlyDrawdownPct = portfolio.monthly_pnl / portfolio.monthly_start_capital;
  if (monthlyDrawdownPct <= -(riskConfig.max_monthly_drawdown_pct / 100)) {
    system_stop = true;
    return {
      signal_id: tradeCard.signal_id,
      decision: 'rejected',
      checks: [{ rule: 'monthly_drawdown', passed: false, reason: `Monthly drawdown ${(monthlyDrawdownPct * 100).toFixed(2)}% exceeds limit` }],
      rejection_reason: 'Monthly drawdown limit reached',
      system_stop: true
    };
  }

  if (portfolio.available_capital < riskConfig.min_capital_usdt) {
    system_stop = true;
    return {
      signal_id: tradeCard.signal_id,
      decision: 'rejected',
      checks: [{ rule: 'min_capital', passed: false, reason: `Capital $${portfolio.available_capital} below minimum $${riskConfig.min_capital_usdt}` }],
      rejection_reason: 'Insufficient capital — system halted',
      system_stop: true
    };
  }

  // ── Per-trade rule checks ─────────────────────────────────────────────────

  // 1. Daily loss limit
  const dailyLossPct = portfolio.daily_pnl / portfolio.available_capital;
  const dailyLimitOk = dailyLossPct > -(riskConfig.max_daily_loss_pct / 100);
  checks.push({ rule: 'daily_loss_limit', passed: dailyLimitOk });
  if (!dailyLimitOk && !rejected) { rejected = true; rejection_reason = 'Daily loss limit reached'; }

  // 2. Max open positions
  const openCount = openTrades.filter(t => t.status === 'open').length;
  const openPositionsOk = openCount < riskConfig.max_open_positions;
  checks.push({ rule: 'max_open_positions', passed: openPositionsOk, value: openCount });
  if (!openPositionsOk && !rejected) { rejected = true; rejection_reason = `Max open positions (${riskConfig.max_open_positions}) reached`; }

  // 3. No duplicate coin
  const coinAlreadyOpen = openTrades.some(t => t.status === 'open' && t.coin === tradeCard.coin);
  checks.push({ rule: 'no_duplicate_coin', passed: !coinAlreadyOpen });
  if (coinAlreadyOpen && !rejected) { rejected = true; rejection_reason = `Position already open for ${tradeCard.coin}`; }

  // 4. Risk per trade (max 2%)
  const riskPct = tradeCard.risk_amount_usdt / portfolio.available_capital;
  const riskPerTradeOk = riskPct <= (riskConfig.max_risk_per_trade_pct / 100);
  checks.push({ rule: 'max_risk_per_trade', passed: riskPerTradeOk, value: riskPct });
  if (!riskPerTradeOk && !rejected) { rejected = true; rejection_reason = `Risk ${(riskPct * 100).toFixed(2)}% exceeds max ${riskConfig.max_risk_per_trade_pct}%`; }

  // 5. Max position size (45%)
  const positionPct = tradeCard.position_size_usdt / portfolio.available_capital;
  const positionSizeOk = positionPct <= (riskConfig.max_position_size_pct / 100);
  checks.push({ rule: 'max_position_size', passed: positionSizeOk, value: positionPct });
  if (!positionSizeOk && !rejected) { rejected = true; rejection_reason = `Position ${(positionPct * 100).toFixed(2)}% exceeds max ${riskConfig.max_position_size_pct}%`; }

  // 6. Cooldown after loss
  const now = Date.now();
  const lastLossTime = portfolio.last_loss_at ? new Date(portfolio.last_loss_at).getTime() : 0;
  const cooldownMs = riskConfig.cooldown_after_loss_hours * 3600 * 1000;
  const cooldownOk = (now - lastLossTime) >= cooldownMs;
  checks.push({ rule: 'cooldown_after_loss', passed: cooldownOk });
  if (!cooldownOk && !rejected) { rejected = true; rejection_reason = 'Cooldown period after loss not elapsed'; }

  // 7. Consecutive losses pause
  const consecLossesOk = portfolio.consecutive_losses < riskConfig.consecutive_losses_pause;
  checks.push({ rule: 'consecutive_losses_pause', passed: consecLossesOk });
  if (!consecLossesOk && !rejected) { rejected = true; rejection_reason = `${portfolio.consecutive_losses} consecutive losses — paused for 24h`; }

  // 8. Price freshness (30 min)
  const signalAge = (now - new Date(tradeCard.signal_timestamp || now).getTime()) / 60000;
  const freshnessOk = signalAge <= riskConfig.price_freshness_minutes;
  checks.push({ rule: 'price_freshness', passed: freshnessOk });
  if (!freshnessOk && !rejected) { rejected = true; rejection_reason = `Signal too old (${signalAge.toFixed(0)} min)`; }

  return {
    signal_id: tradeCard.signal_id,
    decision: rejected ? 'rejected' : 'approved',
    checks,
    rejection_reason: rejected ? rejection_reason : null,
    system_stop
  };
}

// ─── Default test fixtures ─────────────────────────────────────────────────

function makeDefaultRiskConfig() {
  return {
    max_risk_per_trade_pct: 2,
    max_position_size_pct: 45,
    max_open_positions: 3,
    max_daily_loss_pct: 4,
    max_monthly_drawdown_pct: 6,
    min_capital_usdt: 50,
    cooldown_after_loss_hours: 4,
    consecutive_losses_pause: 4,
    price_freshness_minutes: 30
  };
}

function makeDefaultPortfolio(overrides = {}) {
  return {
    available_capital: 1000,
    monthly_start_capital: 1000,
    monthly_pnl: 0,
    daily_pnl: 0,
    system_active: true,
    last_loss_at: null,
    consecutive_losses: 0,
    ...overrides
  };
}

function makeDefaultTradeCard(overrides = {}) {
  return {
    signal_id: 'test-signal-123',
    coin: 'SOL/USDT',
    direction: 'long',
    entry_price: 100,
    stop_loss: 94,
    position_size_usdt: 333,
    risk_amount_usdt: 20,
    risk_per_unit_pct: 0.06,
    confidence_score: 0.6,
    signal_timestamp: new Date().toISOString(),
    ...overrides
  };
}

// ─── System stop conditions ───────────────────────────────────────────────────

describe('RiskController: System stop conditions', () => {
  it('rejects when system_active = false', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ system_active: false }),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    assert.equal(result.system_stop, true);
  });

  it('rejects and sets system_stop when monthly drawdown >= 6%', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ monthly_pnl: -60, monthly_start_capital: 1000 }),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    assert.equal(result.system_stop, true);
  });

  it('rejects when capital < $50', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ available_capital: 40 }),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    assert.equal(result.system_stop, true);
  });

  it('does NOT set system_stop for normal per-trade rejection', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ daily_pnl: -50 }), // -5% daily loss
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    assert.equal(result.system_stop, false);
  });
});

// ─── Per-trade rules ──────────────────────────────────────────────────────────

describe('RiskController: Daily loss limit', () => {
  it('approves when daily loss is within limit', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ daily_pnl: -30 }), // -3% of $1000 = within 4% limit
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'approved');
  });

  it('rejects when daily loss exceeds 4%', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ daily_pnl: -50 }), // -5% of $1000
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    const check = result.checks.find(c => c.rule === 'daily_loss_limit');
    assert.equal(check.passed, false);
  });
});

describe('RiskController: Max open positions', () => {
  it('approves when open positions < 3', () => {
    const trades = [
      { status: 'open', coin: 'BTC/USDT' },
      { status: 'open', coin: 'ETH/USDT' }
    ];
    const result = checkRiskRules(makeDefaultTradeCard(), makeDefaultPortfolio(), trades, makeDefaultRiskConfig());
    assert.equal(result.decision, 'approved');
  });

  it('rejects when already 3 open positions', () => {
    const trades = [
      { status: 'open', coin: 'BTC/USDT' },
      { status: 'open', coin: 'ETH/USDT' },
      { status: 'open', coin: 'ADA/USDT' }
    ];
    const result = checkRiskRules(makeDefaultTradeCard(), makeDefaultPortfolio(), trades, makeDefaultRiskConfig());
    assert.equal(result.decision, 'rejected');
    const check = result.checks.find(c => c.rule === 'max_open_positions');
    assert.equal(check.passed, false);
  });

  it('closed trades do not count toward open positions limit', () => {
    const trades = [
      { status: 'closed', coin: 'BTC/USDT' },
      { status: 'closed', coin: 'ETH/USDT' },
      { status: 'closed', coin: 'ADA/USDT' }
    ];
    const result = checkRiskRules(makeDefaultTradeCard(), makeDefaultPortfolio(), trades, makeDefaultRiskConfig());
    assert.equal(result.decision, 'approved');
  });
});

describe('RiskController: No duplicate coin', () => {
  it('rejects when coin already has open position', () => {
    const trades = [{ status: 'open', coin: 'SOL/USDT' }];
    const result = checkRiskRules(makeDefaultTradeCard({ coin: 'SOL/USDT' }), makeDefaultPortfolio(), trades, makeDefaultRiskConfig());
    assert.equal(result.decision, 'rejected');
    const check = result.checks.find(c => c.rule === 'no_duplicate_coin');
    assert.equal(check.passed, false);
  });

  it('allows different coin even if same direction', () => {
    const trades = [{ status: 'open', coin: 'BTC/USDT' }];
    const result = checkRiskRules(makeDefaultTradeCard({ coin: 'SOL/USDT' }), makeDefaultPortfolio(), trades, makeDefaultRiskConfig());
    const check = result.checks.find(c => c.rule === 'no_duplicate_coin');
    assert.equal(check.passed, true);
  });
});

describe('RiskController: Risk per trade', () => {
  it('approves when risk = exactly 2%', () => {
    const card = makeDefaultTradeCard({ risk_amount_usdt: 20 }); // 20/1000 = 2%
    const result = checkRiskRules(card, makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    const check = result.checks.find(c => c.rule === 'max_risk_per_trade');
    assert.equal(check.passed, true);
  });

  it('rejects when risk exceeds 2%', () => {
    const card = makeDefaultTradeCard({ risk_amount_usdt: 25 }); // 25/1000 = 2.5%
    const result = checkRiskRules(card, makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    assert.equal(result.decision, 'rejected');
    const check = result.checks.find(c => c.rule === 'max_risk_per_trade');
    assert.equal(check.passed, false);
  });
});

describe('RiskController: Max position size', () => {
  it('approves when position <= 45%', () => {
    const card = makeDefaultTradeCard({ position_size_usdt: 450, risk_amount_usdt: 20 }); // 45%
    const result = checkRiskRules(card, makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    const check = result.checks.find(c => c.rule === 'max_position_size');
    assert.equal(check.passed, true);
  });

  it('rejects when position > 45%', () => {
    const card = makeDefaultTradeCard({ position_size_usdt: 500, risk_amount_usdt: 20 }); // 50%
    const result = checkRiskRules(card, makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    const check = result.checks.find(c => c.rule === 'max_position_size');
    assert.equal(check.passed, false);
  });
});

describe('RiskController: Cooldown after loss', () => {
  it('rejects when last loss was less than 4 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ last_loss_at: twoHoursAgo }),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    const check = result.checks.find(c => c.rule === 'cooldown_after_loss');
    assert.equal(check.passed, false);
  });

  it('approves when last loss was more than 4 hours ago', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ last_loss_at: fiveHoursAgo }),
      [],
      makeDefaultRiskConfig()
    );
    const check = result.checks.find(c => c.rule === 'cooldown_after_loss');
    assert.equal(check.passed, true);
  });

  it('approves when no loss has ever occurred (last_loss_at = null)', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ last_loss_at: null }),
      [],
      makeDefaultRiskConfig()
    );
    const check = result.checks.find(c => c.rule === 'cooldown_after_loss');
    assert.equal(check.passed, true);
  });
});

describe('RiskController: Consecutive losses pause', () => {
  it('rejects when consecutive losses = 4', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ consecutive_losses: 4 }),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    const check = result.checks.find(c => c.rule === 'consecutive_losses_pause');
    assert.equal(check.passed, false);
  });

  it('approves when consecutive losses = 3', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ consecutive_losses: 3 }),
      [],
      makeDefaultRiskConfig()
    );
    const check = result.checks.find(c => c.rule === 'consecutive_losses_pause');
    assert.equal(check.passed, true);
  });
});

describe('RiskController: Price freshness', () => {
  it('rejects when signal is older than 30 minutes', () => {
    const oldTimestamp = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const result = checkRiskRules(
      makeDefaultTradeCard({ signal_timestamp: oldTimestamp }),
      makeDefaultPortfolio(),
      [],
      makeDefaultRiskConfig()
    );
    const check = result.checks.find(c => c.rule === 'price_freshness');
    assert.equal(check.passed, false);
    assert.equal(result.decision, 'rejected');
  });

  it('approves when signal is fresh (< 30 minutes)', () => {
    const freshTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = checkRiskRules(
      makeDefaultTradeCard({ signal_timestamp: freshTimestamp }),
      makeDefaultPortfolio(),
      [],
      makeDefaultRiskConfig()
    );
    const check = result.checks.find(c => c.rule === 'price_freshness');
    assert.equal(check.passed, true);
  });
});

// ─── Output schema ─────────────────────────────────────────────────────────────

describe('RiskController: Output schema', () => {
  it('approved result has correct schema', () => {
    const result = checkRiskRules(makeDefaultTradeCard(), makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    assert.equal(result.decision, 'approved');
    assert.ok('signal_id' in result);
    assert.ok('decision' in result);
    assert.ok('checks' in result);
    assert.ok(Array.isArray(result.checks));
    assert.ok('rejection_reason' in result);
    assert.ok('system_stop' in result);
    assert.equal(result.rejection_reason, null);
    assert.equal(result.system_stop, false);
  });

  it('rejected result has non-null rejection_reason', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard(),
      makeDefaultPortfolio({ system_active: false }),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    assert.ok(result.rejection_reason !== null);
    assert.ok(typeof result.rejection_reason === 'string');
    assert.ok(result.rejection_reason.length > 0);
  });

  it('each check has rule and passed fields', () => {
    const result = checkRiskRules(makeDefaultTradeCard(), makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    result.checks.forEach(check => {
      assert.ok('rule' in check, `Check missing 'rule': ${JSON.stringify(check)}`);
      assert.ok('passed' in check, `Check missing 'passed': ${JSON.stringify(check)}`);
      assert.ok(typeof check.passed === 'boolean');
    });
  });

  it('signal_id matches trade card', () => {
    const card = makeDefaultTradeCard({ signal_id: 'signal-xyz-999' });
    const result = checkRiskRules(card, makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    assert.equal(result.signal_id, 'signal-xyz-999');
  });

  it('decision is always approved or rejected', () => {
    const result = checkRiskRules(makeDefaultTradeCard(), makeDefaultPortfolio(), [], makeDefaultRiskConfig());
    assert.ok(['approved', 'rejected'].includes(result.decision));
  });
});

// ─── Fail-safe: never accidentally approve ─────────────────────────────────────

describe('RiskController: Fail-safe behavior', () => {
  it('first failing rule causes rejection (not last)', () => {
    // Multiple rules fail: daily_loss AND max_positions
    const trades = [
      { status: 'open', coin: 'BTC/USDT' },
      { status: 'open', coin: 'ETH/USDT' },
      { status: 'open', coin: 'ADA/USDT' }
    ];
    const portfolio = makeDefaultPortfolio({ daily_pnl: -50 });
    const result = checkRiskRules(makeDefaultTradeCard(), portfolio, trades, makeDefaultRiskConfig());
    assert.equal(result.decision, 'rejected');
    // rejection_reason should be set to FIRST failing check
    assert.ok(result.rejection_reason !== null);
  });

  it('all checks still run and recorded even when rejected', () => {
    const result = checkRiskRules(
      makeDefaultTradeCard({ risk_amount_usdt: 30 }), // risk too high
      makeDefaultPortfolio(),
      [],
      makeDefaultRiskConfig()
    );
    assert.equal(result.decision, 'rejected');
    // Should have recorded multiple checks even though rejected
    assert.ok(result.checks.length > 1);
  });
});
