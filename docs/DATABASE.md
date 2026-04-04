# Databáze — Schéma

## ER Diagram

```
watchlist ──1:N──▶ signals ──1:1──▶ trades
                       │
portfolio ◀────────────┘
                       │
risk_config            │
                       │
audit_log ◀────────────┘
```

## Tabulky

### watchlist
Sledované coiny.

```sql
CREATE TABLE watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol VARCHAR(20) NOT NULL UNIQUE,    -- "SOLUSDT"
    display_name VARCHAR(20) NOT NULL,     -- "SOL/USDT"
    base_asset VARCHAR(10) NOT NULL,       -- "SOL"
    quote_asset VARCHAR(10) NOT NULL,      -- "USDT"
    is_active BOOLEAN DEFAULT true,
    added_at TIMESTAMP DEFAULT NOW(),
    notes TEXT
);
```

### signals
Všechny detekované signály od Scanneru, obohacené Analystem, validované Risk Controllerem.

```sql
CREATE TABLE signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Scanner data
    coin VARCHAR(20) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('long', 'short')),
    signal_type VARCHAR(30) NOT NULL,      -- "breakout_high", "breakout_low"
    signal_data JSONB NOT NULL,            -- surová data ze Scanneru
    
    -- Analyst data
    trade_card JSONB,                       -- kompletní trade karta
    entry_price DECIMAL(20, 8),
    stop_loss DECIMAL(20, 8),
    trailing_atr_mult DECIMAL(4, 2),
    trail_activation_pct DECIMAL(4, 4),
    position_size_usdt DECIMAL(12, 2),
    risk_amount_usdt DECIMAL(12, 2),
    confidence_score DECIMAL(3, 2),
    reasoning TEXT,
    mindsdb_prediction JSONB,
    
    -- Risk Controller data
    risk_checks JSONB,                      -- pole kontrolních výsledků
    rejection_reason TEXT,
    
    -- Status flow: candidate → analyzed → approved/rejected → executed/expired
    status VARCHAR(20) NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'analyzed', 'approved', 'rejected', 
                          'rejected_by_user', 'executed', 'expired')),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    analyzed_at TIMESTAMP,
    decided_at TIMESTAMP,
    executed_at TIMESTAMP,
    expired_at TIMESTAMP,
    
    -- TTL
    expires_at TIMESTAMP                    -- auto-expire po 30 minutách
);

CREATE INDEX idx_signals_status ON signals(status);
CREATE INDEX idx_signals_coin ON signals(coin);
CREATE INDEX idx_signals_created ON signals(created_at DESC);
```

### trades
Všechny exekuované obchody.

```sql
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id UUID REFERENCES signals(id),
    
    -- Trade identifikace
    coin VARCHAR(20) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('long', 'short')),
    
    -- Entry
    entry_price DECIMAL(20, 8) NOT NULL,
    entry_time TIMESTAMP NOT NULL DEFAULT NOW(),
    position_size_usdt DECIMAL(12, 2) NOT NULL,
    position_size_units DECIMAL(20, 8) NOT NULL,
    
    -- Stop management
    initial_stop DECIMAL(20, 8) NOT NULL,
    current_stop DECIMAL(20, 8) NOT NULL,
    trailing_atr_mult DECIMAL(4, 2) NOT NULL DEFAULT 2.5,
    trail_activation_pct DECIMAL(4, 4) NOT NULL DEFAULT 0.04,
    trailing_activated BOOLEAN DEFAULT false,
    highest_since_entry DECIMAL(20, 8),     -- pro long trailing
    lowest_since_entry DECIMAL(20, 8),      -- pro short trailing
    
    -- Exit
    exit_price DECIMAL(20, 8),
    exit_time TIMESTAMP,
    exit_reason VARCHAR(30),               -- "trailing_stop", "manual", "system_stop"
    
    -- P&L
    pnl_usdt DECIMAL(12, 2),
    pnl_pct DECIMAL(8, 4),
    fees_usdt DECIMAL(12, 4) DEFAULT 0,
    
    -- Status
    status VARCHAR(10) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'cancelled')),
    
    -- Exchange data
    exchange_order_id VARCHAR(100),
    exchange VARCHAR(20) DEFAULT 'binance',
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_check_at TIMESTAMP                 -- poslední trailing stop check
);

CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_coin ON trades(coin, status);
CREATE INDEX idx_trades_entry_time ON trades(entry_time DESC);
```

### portfolio
Stav portfolia (jeden řádek, updatuje se).

```sql
CREATE TABLE portfolio (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
    
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
```

### risk_config
Konfigurace risk pravidel (singleton, editovatelný).

```sql
CREATE TABLE risk_config (
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
```

### audit_log
Auditní log všech událostí systému.

```sql
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    
    event_type VARCHAR(50) NOT NULL,
    -- Typy: scanner_run, signal_created, signal_analyzed, signal_approved,
    --       signal_rejected, trade_opened, trade_closed, stop_updated,
    --       system_stop, system_resume, config_changed, error
    
    entity_type VARCHAR(20),               -- "signal", "trade", "portfolio"
    entity_id UUID,
    
    data JSONB,                             -- detail události
    
    severity VARCHAR(10) DEFAULT 'info'
        CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_type ON audit_log(event_type, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_severity ON audit_log(severity) WHERE severity IN ('error', 'critical');
```

## Pomocné funkce

```sql
-- Reset denních metrik (spouštět přes n8n cron o půlnoci)
CREATE OR REPLACE FUNCTION reset_daily_pnl() RETURNS void AS $$
BEGIN
    UPDATE portfolio SET
        today_pnl_usdt = 0,
        today_date = CURRENT_DATE,
        updated_at = NOW()
    WHERE today_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- Reset měsíčních metrik (spouštět 1. den v měsíci)
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

-- Aktualizuj portfolio po uzavření obchodu
CREATE OR REPLACE FUNCTION update_portfolio_after_trade(
    p_pnl_usdt DECIMAL,
    p_position_size DECIMAL,
    p_is_win BOOLEAN
) RETURNS void AS $$
BEGIN
    UPDATE portfolio SET
        available_capital = available_capital + p_position_size + p_pnl_usdt,
        locked_in_positions = locked_in_positions - p_position_size,
        total_value = available_capital + locked_in_positions,
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
```
