-- AlgoTrader — Seed Data
-- Run after migration: psql -U algotrader -d algotrader -f default_config.sql

BEGIN;

-- Watchlist — Top 10 coins
INSERT INTO watchlist (symbol, display_name, base_asset, quote_asset) VALUES
    ('BTCUSDT', 'BTC/USDT', 'BTC', 'USDT'),
    ('ETHUSDT', 'ETH/USDT', 'ETH', 'USDT'),
    ('SOLUSDT', 'SOL/USDT', 'SOL', 'USDT'),
    ('ALGOUSDT', 'ALGO/USDT', 'ALGO', 'USDT'),
    ('AVAXUSDT', 'AVAX/USDT', 'AVAX', 'USDT'),
    ('ADAUSDT', 'ADA/USDT', 'ADA', 'USDT'),
    ('DOTUSDT', 'DOT/USDT', 'DOT', 'USDT'),
    ('LINKUSDT', 'LINK/USDT', 'LINK', 'USDT'),
    ('NEARUSDT', 'NEAR/USDT', 'NEAR', 'USDT'),
    ('MATICUSDT', 'MATIC/USDT', 'MATIC', 'USDT')
ON CONFLICT (symbol) DO NOTHING;

-- Portfolio — initial state
INSERT INTO portfolio (id, initial_capital, available_capital, total_value, month_start_capital)
VALUES (1, 1000.00, 1000.00, 1000.00, 1000.00)
ON CONFLICT (id) DO NOTHING;

-- Risk Config — defaults
INSERT INTO risk_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Initial audit log
INSERT INTO audit_log (event_type, data, severity)
VALUES ('system_init', '{"message": "AlgoTrader initialized", "capital": 1000.00}', 'info');

COMMIT;
