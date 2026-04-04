-- AlgoTrader — Database Migration 001
-- PostgreSQL 15+
-- Run: psql -U algotrader -d algotrader -f 001_init.sql

BEGIN;

-- ============================================
-- TABLES
-- ============================================

CREATE TABLE IF NOT EXISTS watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol VARCHAR(20) NOT NULL UNIQUE,
    display_name VARCHAR(20) NOT NULL,
    base_asset VARCHAR(10) NOT NULL,
    quote_asset VARCHAR(10) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    added_at TIMESTAMP DEFAULT NOW(),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coin VARCHAR(20) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('long', 'short')),
    signal_type VARCHAR(30) NOT NULL,
    signal_data JSONB NOT NULL,
    trade_card JSONB,
    entry_price DECIMAL(20, 8),
    stop_loss DECIMAL(20, 8),
    trailing_atr_mult DECIMAL(4, 2),
    trail_activation_pct DECIMAL(4, 4),
    position_size_usdt DECIMAL(12, 2),
    risk_amount_usdt DECIMAL(12, 2),
    confidence_score DECIMAL(3, 2),
    reasoning TEXT,
    mindsdb_prediction JSONB,
    risk_checks JSONB,
    rejection_reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'analyzed', 'approved', 'rejected',
                          'rejected_by_user', 'executed', 'expired')),
    created_at TIMESTAMP DEFAULT NOW(),
    analyzed_at TIMESTAMP,
    decided_at TIMESTAMP,
    executed_at TIMESTAMP,
    expired_at TIMESTAMP,
    expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_coin ON signals(coin);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id UUID REFERENCES signals(id),
    coin VARCHAR(20) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('long', 'short')),
    entry_price DECIMAL(20, 8) NOT NULL,
    entry_time TIMESTAMP NOT NULL DEFAULT NOW(),
    position_size_usdt DECIMAL(12, 2) NOT NULL,
    position_size_units DECIMAL(20, 8) NOT NULL,
    initial_stop DECIMAL(20, 8) NOT NULL,
    current_stop DECIMAL(20, 8) NOT NULL,
    trailing_atr_mult DECIMAL(4, 2) NOT NULL DEFAULT 2.5,
    trail_activation_pct DECIMAL(4, 4) NOT NULL DEFAULT 0.04,
    trailing_activated BOOLEAN DEFAULT false,
    highest_since_entry DECIMAL(20, 8),
    lowest_since_entry DECIMAL(20, 8),
    exit_price DECIMAL(20, 8),
    exit_time TIMESTAMP,
    exit_reason VARCHAR(30),
    pnl_usdt DECIMAL(12, 2),
    pnl_pct DECIMAL(8, 4),
    fees_usdt DECIMAL(12, 4) DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'cancelled')),
    exchange_order_id VARCHAR(100),
    exchange VARCHAR(20) DEFAULT 'binance',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_check_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_coin ON trades(coin, status);
CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time DESC);

CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    initial_capital DECIMAL(12, 2) NOT NULL DEFAULT 1000.00,
    available_capital DECIMAL(12, 2) NOT NULL DEFAULT 1000.00,
    locked_in_positions DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_value DECIMAL(12, 2) NOT NULL DEFAULT 1000.00,
    total_pnl_usdt DECIMAL(12, 2) DEFAULT 0,
    total_pnl_pct DECIMAL(8, 4) DEFAULT 0,
    today_pnl_usdt DECIMAL(12, 2) DEFAULT 0,
    today_date DATE DEFAULT CURRENT_DATE,
    month_start_capital DECIMAL(12, 2) NOT NULL DEFAULT 1000.00,
    month_pnl_usdt DECIMAL(12, 2) DEFAULT 0,
    month_start_date DATE DEFAULT date_trunc('month', CURRENT_DATE),
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    consecutive_losses INTEGER DEFAULT 0,
    system_active BOOLEAN DEFAULT true,
    system_stop_reason TEXT,
    system_stop_until TIMESTAMP,
    last_loss_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    max_risk_per_trade_pct DECIMAL(4, 2) NOT NULL DEFAULT 2.00,
    max_open_positions INTEGER NOT NULL DEFAULT 3,
    max_daily_loss_pct DECIMAL(4, 2) NOT NULL DEFAULT 4.00,
    max_monthly_drawdown_pct DECIMAL(4, 2) NOT NULL DEFAULT 6.00,
    max_position_size_pct DECIMAL(4, 2) NOT NULL DEFAULT 45.00,
    min_capital DECIMAL(12, 2) NOT NULL DEFAULT 50.00,
    cooldown_after_loss_hours INTEGER NOT NULL DEFAULT 4,
    max_consecutive_losses_pause INTEGER NOT NULL DEFAULT 4,
    consecutive_losses_pause_hours INTEGER NOT NULL DEFAULT 24,
    signal_expiry_minutes INTEGER NOT NULL DEFAULT 30,
    max_price_deviation_pct DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(20),
    entity_id UUID,
    data JSONB,
    severity VARCHAR(10) DEFAULT 'info'
        CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_log(severity) WHERE severity IN ('error', 'critical');

-- ============================================
-- FUNCTIONS
-- ============================================

CREATE OR REPLACE FUNCTION reset_daily_pnl() RETURNS void AS $$
BEGIN
    UPDATE portfolio SET
        today_pnl_usdt = 0,
        today_date = CURRENT_DATE,
        updated_at = NOW()
    WHERE today_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reset_monthly_pnl() RETURNS void AS $$
BEGIN
    UPDATE portfolio SET
        month_start_capital = total_value,
        month_pnl_usdt = 0,
        month_start_date = date_trunc('month', CURRENT_DATE),
        updated_at = NOW()
    WHERE month_start_date < date_trunc('month', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_portfolio_after_trade(
    p_pnl_usdt DECIMAL,
    p_position_size DECIMAL,
    p_is_win BOOLEAN
) RETURNS void AS $$
BEGIN
    UPDATE portfolio SET
        available_capital = available_capital + p_position_size + p_pnl_usdt,
        locked_in_positions = GREATEST(0, locked_in_positions - p_position_size),
        total_value = available_capital + p_position_size + p_pnl_usdt + GREATEST(0, locked_in_positions - p_position_size),
        total_pnl_usdt = total_pnl_usdt + p_pnl_usdt,
        total_pnl_pct = (total_pnl_usdt + p_pnl_usdt) / initial_capital * 100,
        today_pnl_usdt = today_pnl_usdt + p_pnl_usdt,
        month_pnl_usdt = month_pnl_usdt + p_pnl_usdt,
        total_trades = total_trades + 1,
        winning_trades = winning_trades + CASE WHEN p_is_win THEN 1 ELSE 0 END,
        losing_trades = losing_trades + CASE WHEN NOT p_is_win THEN 1 ELSE 0 END,
        consecutive_losses = CASE WHEN p_is_win THEN 0 ELSE consecutive_losses + 1 END,
        last_loss_at = CASE WHEN NOT p_is_win THEN NOW() ELSE last_loss_at END,
        updated_at = NOW()
    WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- Auto-expire staré signály
CREATE OR REPLACE FUNCTION expire_old_signals() RETURNS void AS $$
BEGIN
    UPDATE signals SET
        status = 'expired',
        expired_at = NOW()
    WHERE status IN ('candidate', 'analyzed', 'approved')
      AND expires_at IS NOT NULL
      AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

COMMIT;
