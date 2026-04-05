# Databáze — Schéma

## ER Diagram

```
watchlist ──1:N──▶ signals ──1:1──▶ trades
                       │
portfolio ◀────────────┤          (CEX portfolio)
dex_portfolio ◀────────┤          (DEX portfolio)
                       │
risk_config            │
                       │
audit_log ◀────────────┘

dex_tokens ──1:N──▶ watchlist (chain='solana')
```

## Migrace

Schéma je rozděleno do dvou migrací:

| Soubor | Obsah |
|--------|-------|
| `db/migrations/001_init.sql` | Základní tabulky: watchlist, signals, trades, portfolio, risk_config, audit_log |
| `db/migrations/002_dex.sql` | DEX rozšíření: chain/token_address sloupce, tabulky dex_tokens, dex_portfolio |

---

## Tabulky

### watchlist
Sledované instrumenty — CEX páry i DEX tokeny.

```sql
CREATE TABLE watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol VARCHAR(20) NOT NULL UNIQUE,    -- "SOLUSDT" nebo "SOL"
    display_name VARCHAR(20) NOT NULL,     -- "SOL/USDT" nebo "SOL/USDC"
    base_asset VARCHAR(10) NOT NULL,       -- "SOL"
    quote_asset VARCHAR(10) NOT NULL,      -- "USDT" nebo "USDC"
    is_active BOOLEAN DEFAULT true,
    -- DEX rozšíření (002_dex.sql)
    chain VARCHAR(20) DEFAULT 'cex',       -- 'cex' | 'solana'
    token_address VARCHAR(100),            -- SPL token address (pro DEX)
    quote_token_address VARCHAR(100),      -- obvykle USDC mint
    added_at TIMESTAMP DEFAULT NOW(),
    notes TEXT
);
```

**Seed data (`db/seeds/dex_watchlist.sql`):**

| Symbol | Chain | Aktivní | Token |
|--------|-------|---------|-------|
| SOL | solana | ✅ | `So1111...112` |
| JUP | solana | ✅ | `JUPyiwr...CN` |
| RAY | solana | ✅ | `4k3Dyjz...R` |
| ORCA | solana | ✅ | `orcaEKT...E` |
| BONK | solana | ❌ | `DezXAZ8...63` |
| WIF | solana | ❌ | `EKpQGSJ...m` |

---

### signals
Všechny detekované signály — CEX i DEX.

```sql
CREATE TABLE signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Scanner data
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('long', 'short')),
    signal_type VARCHAR(30),               -- "breakout_high", "breakout_low"
    signal_data JSONB NOT NULL,            -- surová data ze Scanneru + trade karta + RC

    -- Status flow
    status VARCHAR(20) NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'analyzed', 'approved', 'rejected',
                          'rejected_by_user', 'executed', 'expired', 'failed')),

    -- DEX rozšíření (002_dex.sql)
    chain VARCHAR(20) DEFAULT 'cex',       -- 'cex' | 'solana'

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    analyzed_at TIMESTAMP,
    decided_at TIMESTAMP,
    executed_at TIMESTAMP,
    expires_at TIMESTAMP
);

CREATE INDEX idx_signals_status ON signals(status);
CREATE INDEX idx_signals_chain  ON signals(chain);
CREATE INDEX idx_signals_created ON signals(created_at DESC);
```

**Poznámka:** Trade karta (výstup Analystu), MindsDB predikce a RC výsledek jsou uloženy v `signal_data` JSONB — nevyžadují separátní sloupce.

---

### trades
Všechny exekuované obchody — CEX i DEX.

```sql
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id UUID REFERENCES signals(id),

    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('long', 'short')),
    side VARCHAR(5) DEFAULT 'buy',

    -- Entry
    entry_price DECIMAL(20, 8) NOT NULL,
    entry_time TIMESTAMP NOT NULL DEFAULT NOW(),
    position_size_usdt DECIMAL(12, 2) NOT NULL,

    -- Stop management
    stop_loss_price DECIMAL(20, 8),
    take_profit_price DECIMAL(20, 8),
    current_stop DECIMAL(20, 8),
    trailing_atr_mult DECIMAL(4, 2) DEFAULT 2.5,
    trail_activation_pct DECIMAL(4, 4) DEFAULT 0.04,
    trailing_activated BOOLEAN DEFAULT false,
    highest_since_entry DECIMAL(20, 8),
    lowest_since_entry DECIMAL(20, 8),

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

    -- Exchange / DEX identifikace
    exchange VARCHAR(20) DEFAULT 'binance',
    exchange_order_id VARCHAR(100),

    -- DEX rozšíření (002_dex.sql)
    chain VARCHAR(20) DEFAULT 'cex',
    dex VARCHAR(20),                       -- 'jupiter'
    token_address VARCHAR(100),
    quote_token_address VARCHAR(100),
    tx_signature VARCHAR(100),             -- Solana tx hash
    chain_data JSONB,                      -- { slippage_bps, price_impact_pct, route_plan, decimals }

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_check_at TIMESTAMP
);

CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_chain  ON trades(chain, status);
CREATE INDEX idx_trades_entry_time ON trades(entry_time DESC);
```

---

### portfolio
Stav CEX portfolia (singleton).

```sql
CREATE TABLE portfolio (
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
```

---

### dex_portfolio
Stav DEX portfolia — Solana hot wallet (singleton).

```sql
CREATE TABLE dex_portfolio (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Zůstatky
    usdc_balance DECIMAL(18, 6) NOT NULL DEFAULT 200.00,  -- $200 výchozí
    sol_balance DECIMAL(18, 9) NOT NULL DEFAULT 0.00,
    available_usdc DECIMAL(18, 6) NOT NULL DEFAULT 200.00,
    locked_in_positions DECIMAL(18, 6) NOT NULL DEFAULT 0.00,
    total_value_usdt DECIMAL(12, 2) NOT NULL DEFAULT 200.00,

    -- P&L
    total_pnl_usdt DECIMAL(12, 2) DEFAULT 0,
    today_pnl_usdt DECIMAL(12, 2) DEFAULT 0,
    today_date DATE DEFAULT CURRENT_DATE,
    month_pnl_usdt DECIMAL(12, 2) DEFAULT 0,
    month_start_usdc DECIMAL(18, 6) NOT NULL DEFAULT 200.00,
    month_start_date DATE DEFAULT date_trunc('month', CURRENT_DATE),

    -- Statistiky
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    consecutive_losses INTEGER DEFAULT 0,
    last_loss_at TIMESTAMP,

    -- Systém
    system_active BOOLEAN DEFAULT true,
    system_stop_reason TEXT,

    updated_at TIMESTAMP DEFAULT NOW()
);
```

**Výchozí hodnoty** nastaveny v `db/seeds/dex_watchlist.sql`:
```sql
INSERT INTO dex_portfolio (usdc_balance, available_usdc, total_value_usdt, month_start_usdc)
VALUES (200.00, 200.00, 200.00, 200.00)
ON CONFLICT (id) DO NOTHING;
```

---

### dex_tokens
Metadata Solana tokenů.

```sql
CREATE TABLE dex_tokens (
    address VARCHAR(100) PRIMARY KEY,      -- SPL token mint address
    chain VARCHAR(20) NOT NULL DEFAULT 'solana',
    symbol VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    decimals INTEGER NOT NULL DEFAULT 6,
    is_active BOOLEAN DEFAULT true,
    liquidity_usd DECIMAL(20, 2),          -- aktuální likvidita poolu (Birdeye)
    price_usd DECIMAL(20, 8),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

---

### risk_config
Konfigurace risk pravidel (singleton).

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

---

### audit_log
Auditní log všech událostí systému.

```sql
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(20),               -- "signal", "trade", "portfolio"
    entity_id UUID,
    data JSONB,
    severity VARCHAR(10) DEFAULT 'info'
        CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Inicializace databáze

```bash
# Lokální vývoj
psql -h localhost -U algotrader -d algotrader \
  -f db/migrations/001_init.sql \
  -f db/migrations/002_dex.sql \
  -f db/seeds/default_config.sql \
  -f db/seeds/dex_watchlist.sql
```

Docker Compose automaticky spustí `001_init.sql` při prvním startu (`docker-entrypoint-initdb.d`).
Migrace `002_dex.sql` a DEX seeds je potřeba spustit ručně.

---

## Pomocné SQL funkce

```sql
-- Reset denních metrik (cron o půlnoci — Workflow 06)
CREATE OR REPLACE FUNCTION reset_daily_pnl() RETURNS void AS $$
BEGIN
    UPDATE portfolio    SET today_pnl_usdt = 0, today_date = CURRENT_DATE WHERE today_date < CURRENT_DATE;
    UPDATE dex_portfolio SET today_pnl_usdt = 0, today_date = CURRENT_DATE WHERE today_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- Reset měsíčních metrik (1. den v měsíci — Workflow 07)
CREATE OR REPLACE FUNCTION reset_monthly_pnl() RETURNS void AS $$
BEGIN
    UPDATE portfolio SET
        month_start_capital = total_value,
        month_pnl_usdt = 0,
        month_start_date = date_trunc('month', CURRENT_DATE)
    WHERE month_start_date < date_trunc('month', CURRENT_DATE);

    UPDATE dex_portfolio SET
        month_start_usdc = usdc_balance,
        month_pnl_usdt = 0,
        month_start_date = date_trunc('month', CURRENT_DATE)
    WHERE month_start_date < date_trunc('month', CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;
```
