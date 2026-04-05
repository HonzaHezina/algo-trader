-- AlgoTrader — DEX Watchlist Seeds (Solana)
-- Přidá základní Solana tokeny do watchlistu
-- Run: psql -U algotrader -d algotrader -f db/seeds/dex_watchlist.sql
--
-- Token adresy ověř na: https://birdeye.so nebo https://solscan.io

INSERT INTO watchlist (symbol, display_name, base_asset, quote_asset, chain, token_address, quote_token_address, is_active, notes)
VALUES
  -- Large caps (dostatečná likvidita pro pozice $200+)
  ('SOL',   'SOL/USDC',  'SOL',   'USDC', 'solana',
   'So11111111111111111111111111111111111111112',
   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   true, 'Wrapped SOL'),

  ('JUP',   'JUP/USDC',  'JUP',   'USDC', 'solana',
   'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   true, 'Jupiter DEX token'),

  ('RAY',   'RAY/USDC',  'RAY',   'USDC', 'solana',
   '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   true, 'Raydium DEX token'),

  ('ORCA',  'ORCA/USDC', 'ORCA',  'USDC', 'solana',
   'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   true, 'Orca DEX token'),

  -- Mid caps (zapni až po ověření strategie na large caps)
  ('BONK',  'BONK/USDC', 'BONK',  'USDC', 'solana',
   'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   false, 'Meme coin - vysoká volatilita, vypnuto by default'),

  ('WIF',   'WIF/USDC',  'WIF',   'USDC', 'solana',
   'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   false, 'Meme coin - vysoká volatilita, vypnuto by default')

ON CONFLICT (symbol) DO NOTHING;

-- DEX token metadata
INSERT INTO dex_tokens (address, chain, symbol, name, decimals)
VALUES
  ('So11111111111111111111111111111111111111112', 'solana', 'SOL',  'Wrapped SOL',  9),
  ('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana', 'USDC', 'USD Coin',  6),
  ('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'solana', 'JUP',  'Jupiter',    6),
  ('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'solana', 'RAY',  'Raydium',   6),
  ('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', 'solana', 'ORCA', 'Orca',       6),
  ('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'solana', 'BONK', 'Bonk',     5),
  ('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'solana', 'WIF',  'dogwifhat', 6)

ON CONFLICT (address) DO NOTHING;

-- DEX portfolio init (USDC, nastav dle skutečného zůstatku)
INSERT INTO dex_portfolio (id, chain, usdc_balance, available_usdc, total_value_usdt, month_start_usdc)
VALUES (1, 'solana', 200.00, 200.00, 200.00, 200.00)
ON CONFLICT (id) DO NOTHING;
