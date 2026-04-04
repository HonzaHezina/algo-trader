-- AlgoTrader — MindsDB Setup
-- Spusť jednou po nasbírání historických dat (min. 500 signálů s výsledky)
--
-- Prerekvizity:
--   1. MindsDB kontejner běží: docker compose --profile mindsdb up -d mindsdb
--   2. MindsDB je dostupné na http://localhost:47334
--   3. PostgreSQL připojení je nakonfigurované v MindsDB
--
-- Spuštění:
--   curl -X POST http://localhost:47334/api/sql/query \
--     -H "Content-Type: application/json" \
--     -d @scripts/setup_mindsdb.sql
--
-- Nebo přes MindsDB editor na http://localhost:47334

-- ============================================
-- 1. Připojení MindsDB k PostgreSQL
-- ============================================

CREATE DATABASE IF NOT EXISTS algotrader_db
WITH ENGINE = 'postgres',
PARAMETERS = {
  "host": "postgres",
  "port": 5432,
  "database": "algotrader",
  "user": "algotrader",
  "password": "{{POSTGRES_PASSWORD}}"
};

-- ============================================
-- 2. Tréninkový dataset (view nad signals + trades)
-- ============================================

CREATE VIEW IF NOT EXISTS algotrader_db.training_data AS
  SELECT
    s.signal_data->>'current_price'   AS close,
    (s.signal_data->>'latest_volume')::float AS volume,
    (s.signal_data->>'atr14')::float  AS atr14,
    (s.signal_data->>'momentum_roc12')::float AS roc12,
    (s.signal_data->>'volume_ratio')::float AS volume_ratio,
    -- Skutečný výsledek: pokud byl trade profitabilní v horizontu 6x4h svíček (24h)
    CASE
      WHEN t.pnl_usdt > 0 THEN 'bullish'
      WHEN t.pnl_usdt < 0 THEN 'bearish'
      ELSE 'neutral'
    END AS direction,
    CASE
      WHEN t.pnl_usdt IS NOT NULL
        THEN ROUND((t.pnl_usdt / t.position_size_usdt * 100)::numeric, 2)
      ELSE 0
    END AS predicted_move_pct
  FROM signals s
  LEFT JOIN trades t ON t.signal_id = s.id
  WHERE s.status IN ('executed', 'rejected')
    AND s.signal_data->>'current_price' IS NOT NULL
    AND s.signal_data->>'atr14' IS NOT NULL;

-- ============================================
-- 3. Vytvoření ML modelu
-- ============================================

CREATE MODEL IF NOT EXISTS mindsdb.price_predictor
PREDICT direction, predicted_move_pct
USING
  engine      = 'lightwood',
  target      = 'direction',
  input_columns = ['close', 'volume', 'atr14', 'roc12', 'volume_ratio'],
  window      = 30,
  horizon     = 6
FROM algotrader_db (
  SELECT close, volume, atr14, roc12, volume_ratio, direction, predicted_move_pct
  FROM training_data
  WHERE direction IS NOT NULL
);

-- ============================================
-- 4. Ověření modelu (spusť po dokončení trénování)
-- ============================================

-- Zkontroluj stav trénování:
-- SELECT name, status, error FROM mindsdb.models WHERE name = 'price_predictor';

-- Testovací predikce:
-- SELECT direction, confidence, predicted_move_pct
-- FROM mindsdb.price_predictor
-- WHERE close = 142.50
--   AND volume = 2500000
--   AND atr14 = 3.65
--   AND roc12 = 0.042
--   AND volume_ratio = 1.8;
