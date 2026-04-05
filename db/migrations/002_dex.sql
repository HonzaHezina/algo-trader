-- AlgoTrader — Database Migration 002 — DEX Support
-- PostgreSQL 16
-- Run: psql -U algotrader -d algotrader -f db/migrations/002_dex.sql

BEGIN;

-- ============================================
-- Extend existing tables for multi-chain
-- ============================================

-- Add chain info to watchlist
ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS chain VARCHAR(20) NOT NULL DEFAULT 'cex',
  ADD COLUMN IF NOT EXISTS token_address VARCHAR(100),
  ADD COLUMN IF NOT EXISTS quote_token_address VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_watchlist_chain ON watchlist(chain, is_active);

-- Add chain info to signals
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS chain VARCHAR(20) NOT NULL DEFAULT 'cex';

CREATE INDEX IF NOT EXISTS idx_signals_chain ON signals(chain, status);

-- Add chain info to trades
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS chain VARCHAR(20) NOT NULL DEFAULT 'cex',
  ADD COLUMN IF NOT EXISTS tx_signature VARCHAR(150),
  ADD COLUMN IF NOT EXISTS dex VARCHAR(30),
  ADD COLUMN IF NOT EXISTS token_address VARCHAR(100),
  ADD COLUMN IF NOT EXISTS quote_token_address VARCHAR(100),
  ADD COLUMN IF NOT EXISTS chain_data JSONB;

CREATE INDEX IF NOT EXISTS idx_trades_chain ON trades(chain, status);

-- ============================================
-- DEX token metadata
-- ============================================

CREATE TABLE IF NOT EXISTS dex_tokens (
  address        VARCHAR(100) PRIMARY KEY,
  chain          VARCHAR(20) NOT NULL DEFAULT 'solana',
  symbol         VARCHAR(30) NOT NULL,
  name           VARCHAR(100),
  decimals       INTEGER NOT NULL DEFAULT 6,
  is_active      BOOLEAN DEFAULT true,
  liquidity_usd  DECIMAL(20, 2),
  price_usd      DECIMAL(20, 10),
  updated_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dex_tokens_chain ON dex_tokens(chain, is_active);

-- ============================================
-- DEX portfolio — separate from CEX
-- ============================================

CREATE TABLE IF NOT EXISTS dex_portfolio (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chain                VARCHAR(20) NOT NULL DEFAULT 'solana',
  wallet_address       VARCHAR(100),
  usdc_balance         DECIMAL(20, 6) NOT NULL DEFAULT 0,
  sol_balance          DECIMAL(20, 9) NOT NULL DEFAULT 0,
  locked_in_positions  DECIMAL(20, 6) NOT NULL DEFAULT 0,
  available_usdc       DECIMAL(20, 6) NOT NULL DEFAULT 0,
  total_value_usdt     DECIMAL(20, 2) NOT NULL DEFAULT 0,
  total_pnl_usdt       DECIMAL(12, 2) DEFAULT 0,
  today_pnl_usdt       DECIMAL(12, 2) DEFAULT 0,
  today_date           DATE DEFAULT CURRENT_DATE,
  month_start_usdc     DECIMAL(20, 6) NOT NULL DEFAULT 0,
  month_pnl_usdt       DECIMAL(12, 2) DEFAULT 0,
  month_start_date     DATE DEFAULT date_trunc('month', CURRENT_DATE),
  total_trades         INTEGER DEFAULT 0,
  winning_trades       INTEGER DEFAULT 0,
  losing_trades        INTEGER DEFAULT 0,
  consecutive_losses   INTEGER DEFAULT 0,
  system_active        BOOLEAN DEFAULT true,
  last_loss_at         TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT NOW()
);

COMMIT;
