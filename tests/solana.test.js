'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  USDC_MINT,
  USDC_DECIMALS,
  parseBirdeyeOHLCV,
  buildBirdeyeOHLCVRequest,
  buildJupiterQuoteUrl,
  buildJupiterSellUrl,
  calcDynamicSlippage,
  parseJupiterQuote,
  calcEffectivePrice,
  fromLamports,
  toLamports
} = require('../lib/solana');

// ─── Constants ────────────────────────────────────────────────────────────────

describe('Constants', () => {
  it('USDC_MINT is correct mainnet address', () => {
    assert.equal(USDC_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('USDC_DECIMALS is 6', () => {
    assert.equal(USDC_DECIMALS, 6);
  });
});

// ─── parseBirdeyeOHLCV ────────────────────────────────────────────────────────

describe('parseBirdeyeOHLCV: valid response', () => {
  const mockResponse = {
    data: {
      items: [
        { unixTime: 1700000000, open: '100.5', high: '105.0', low: '99.0', close: '103.0', volume: '250000.5' },
        { unixTime: 1700014400, open: '103.0', high: '110.0', low: '102.0', close: '108.5', volume: '310000.0' }
      ]
    }
  };

  it('returns array of correct length', () => {
    const candles = parseBirdeyeOHLCV(mockResponse);
    assert.equal(candles.length, 2);
  });

  it('converts timestamp to ISO string', () => {
    const candles = parseBirdeyeOHLCV(mockResponse);
    assert.equal(candles[0].timestamp, new Date(1700000000 * 1000).toISOString());
  });

  it('parses OHLCV as floats', () => {
    const candles = parseBirdeyeOHLCV(mockResponse);
    assert.equal(candles[0].open,   100.5);
    assert.equal(candles[0].high,   105.0);
    assert.equal(candles[0].low,     99.0);
    assert.equal(candles[0].close,  103.0);
    assert.equal(candles[0].volume, 250000.5);
  });

  it('returns number types (not strings)', () => {
    const candles = parseBirdeyeOHLCV(mockResponse);
    assert.ok(typeof candles[0].open   === 'number');
    assert.ok(typeof candles[0].volume === 'number');
  });
});

describe('parseBirdeyeOHLCV: invalid input', () => {
  it('throws on null response', () => {
    assert.throws(() => parseBirdeyeOHLCV(null), /parseBirdeyeOHLCV/);
  });

  it('throws on missing data.items', () => {
    assert.throws(() => parseBirdeyeOHLCV({ data: {} }), /parseBirdeyeOHLCV/);
  });

  it('throws on empty items array', () => {
    assert.throws(() => parseBirdeyeOHLCV({ data: { items: [] } }), /parseBirdeyeOHLCV/);
  });
});

// ─── buildBirdeyeOHLCVRequest ─────────────────────────────────────────────────

describe('buildBirdeyeOHLCVRequest', () => {
  const TOKEN = 'So11111111111111111111111111111111111111112';

  it('returns correct URL structure', () => {
    const { url } = buildBirdeyeOHLCVRequest(TOKEN, '4H', 200);
    assert.ok(url.startsWith('https://public-api.birdeye.so/defi/ohlcv'));
    assert.ok(url.includes(`address=${TOKEN}`));
    assert.ok(url.includes('type=4H'));
  });

  it('includes time_from and time_to', () => {
    const { url } = buildBirdeyeOHLCVRequest(TOKEN, '4H', 200);
    assert.ok(url.includes('time_from='));
    assert.ok(url.includes('time_to='));
  });

  it('time_from is approximately 200 * 14400 seconds before now', () => {
    const before = Math.floor(Date.now() / 1000);
    const { url } = buildBirdeyeOHLCVRequest(TOKEN, '4H', 200);
    const after  = Math.floor(Date.now() / 1000);
    const match  = url.match(/time_from=(\d+)/);
    const timeFrom = parseInt(match[1]);
    const expected = before - (200 * 14400);
    // Allow ±2s tolerance
    assert.ok(Math.abs(timeFrom - expected) <= 2);
  });

  it('uses x-chain: solana header', () => {
    const { headers } = buildBirdeyeOHLCVRequest(TOKEN);
    assert.equal(headers['x-chain'], 'solana');
  });

  it('supports different intervals', () => {
    const { url: url1h } = buildBirdeyeOHLCVRequest(TOKEN, '1H', 100);
    assert.ok(url1h.includes('type=1H'));

    const { url: url15m } = buildBirdeyeOHLCVRequest(TOKEN, '15m', 50);
    assert.ok(url15m.includes('type=15m'));
  });

  it('defaults to 4H interval', () => {
    const { url } = buildBirdeyeOHLCVRequest(TOKEN);
    assert.ok(url.includes('type=4H'));
  });
});

// ─── buildJupiterQuoteUrl ─────────────────────────────────────────────────────

describe('buildJupiterQuoteUrl', () => {
  const OUTPUT_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

  it('uses USDC as inputMint', () => {
    const url = buildJupiterQuoteUrl(OUTPUT_MINT, 100, 50);
    assert.ok(url.includes(`inputMint=${USDC_MINT}`));
  });

  it('uses correct outputMint', () => {
    const url = buildJupiterQuoteUrl(OUTPUT_MINT, 100, 50);
    assert.ok(url.includes(`outputMint=${OUTPUT_MINT}`));
  });

  it('converts $100 USDC to correct lamports (100_000_000)', () => {
    const url = buildJupiterQuoteUrl(OUTPUT_MINT, 100, 50);
    assert.ok(url.includes('amount=100000000'));
  });

  it('uses given slippageBps', () => {
    const url = buildJupiterQuoteUrl(OUTPUT_MINT, 50, 100);
    assert.ok(url.includes('slippageBps=100'));
  });

  it('defaults to 50 bps slippage', () => {
    const url = buildJupiterQuoteUrl(OUTPUT_MINT, 50);
    assert.ok(url.includes('slippageBps=50'));
  });
});

// ─── buildJupiterSellUrl ──────────────────────────────────────────────────────

describe('buildJupiterSellUrl', () => {
  const INPUT_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

  it('uses USDC as outputMint (selling to USDC)', () => {
    const url = buildJupiterSellUrl(INPUT_MINT, 1000, 6, 100);
    assert.ok(url.includes(`outputMint=${USDC_MINT}`));
  });

  it('uses correct inputMint (token being sold)', () => {
    const url = buildJupiterSellUrl(INPUT_MINT, 1000, 6, 100);
    assert.ok(url.includes(`inputMint=${INPUT_MINT}`));
  });

  it('converts 1 token (6 decimals) to 1_000_000 lamports', () => {
    const url = buildJupiterSellUrl(INPUT_MINT, 1, 6, 100);
    assert.ok(url.includes('amount=1000000'));
  });

  it('converts 1 SOL (9 decimals) to 1_000_000_000 lamports', () => {
    const url = buildJupiterSellUrl(INPUT_MINT, 1, 9, 100);
    assert.ok(url.includes('amount=1000000000'));
  });
});

// ─── calcDynamicSlippage ──────────────────────────────────────────────────────

describe('calcDynamicSlippage', () => {
  it('returns 200 bps when liquidity is 0 (unknown)', () => {
    assert.equal(calcDynamicSlippage(100, 0), 200);
  });

  it('returns 200 bps when liquidity is null', () => {
    assert.equal(calcDynamicSlippage(100, null), 200);
  });

  it('returns 30 bps when position < 0.1% of pool', () => {
    // 1 USDC in 10_000 USDC pool = 0.01% → 30 bps
    assert.equal(calcDynamicSlippage(1, 10000), 30);
  });

  it('returns 50 bps when position 0.1%-0.5% of pool', () => {
    // 20 in 10_000 = 0.2% → 50 bps
    assert.equal(calcDynamicSlippage(20, 10000), 50);
  });

  it('returns 100 bps when position 0.5%-1% of pool', () => {
    // 80 in 10_000 = 0.8% → 100 bps
    assert.equal(calcDynamicSlippage(80, 10000), 100);
  });

  it('returns 200 bps when position 1%-2% of pool', () => {
    // 150 in 10_000 = 1.5% → 200 bps
    assert.equal(calcDynamicSlippage(150, 10000), 200);
  });

  it('returns 300 bps when position > 2% of pool', () => {
    // 500 in 10_000 = 5% → 300 bps
    assert.equal(calcDynamicSlippage(500, 10000), 300);
  });
});

// ─── parseJupiterQuote ────────────────────────────────────────────────────────

describe('parseJupiterQuote', () => {
  const mockQuote = {
    inputMint:      USDC_MINT,
    outputMint:     'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    inAmount:       '100000000',   // 100 USDC
    outAmount:      '68493150',    // ~68.49 JUP (6 decimals)
    priceImpactPct: '0.12',
    slippageBps:    50,
    routePlan:      [
      { swapInfo: { label: 'Raydium' } },
      { swapInfo: { label: 'Orca' } }
    ]
  };

  it('parses inputAmount as integer', () => {
    const result = parseJupiterQuote(mockQuote);
    assert.equal(result.inputAmount, 100000000);
    assert.ok(typeof result.inputAmount === 'number');
  });

  it('parses outputAmount as integer', () => {
    const result = parseJupiterQuote(mockQuote);
    assert.equal(result.outputAmount, 68493150);
  });

  it('parses priceImpactPct as float', () => {
    const result = parseJupiterQuote(mockQuote);
    assert.equal(result.priceImpactPct, 0.12);
  });

  it('extracts route labels', () => {
    const result = parseJupiterQuote(mockQuote);
    assert.deepEqual(result.routePlan, ['Raydium', 'Orca']);
  });

  it('preserves slippageBps', () => {
    const result = parseJupiterQuote(mockQuote);
    assert.equal(result.slippageBps, 50);
  });

  it('throws on invalid quote (no outAmount)', () => {
    assert.throws(() => parseJupiterQuote({}), /parseJupiterQuote/);
    assert.throws(() => parseJupiterQuote(null), /parseJupiterQuote/);
  });
});

// ─── calcEffectivePrice ───────────────────────────────────────────────────────

describe('calcEffectivePrice', () => {
  it('calculates USDC per token correctly', () => {
    // 100 USDC (6 decimals) → 68493150 JUP lamports (6 decimals)
    const quote = { inputAmount: 100000000, outputAmount: 68493150 };
    const price  = calcEffectivePrice(quote, 6);
    // 100 USDC / 68.49315 JUP ≈ 1.4601
    assert.ok(Math.abs(price - 1.4601) < 0.001);
  });

  it('handles 9-decimal SOL correctly', () => {
    // 100 USDC → 0.5 SOL (9 decimals) = 500_000_000 lamports
    const quote = { inputAmount: 100000000, outputAmount: 500000000 };
    const price  = calcEffectivePrice(quote, 9);
    // 100 USDC / 0.5 SOL = 200 USDC/SOL
    assert.equal(price, 200);
  });

  it('returns 0 when outputAmount is 0', () => {
    const price = calcEffectivePrice({ inputAmount: 100000000, outputAmount: 0 }, 6);
    assert.equal(price, 0);
  });
});

// ─── fromLamports / toLamports ────────────────────────────────────────────────

describe('fromLamports', () => {
  it('converts 1_000_000 USDC lamports to 1 USDC', () => {
    assert.equal(fromLamports(1000000, 6), 1);
  });

  it('converts 1_000_000_000 SOL lamports to 1 SOL', () => {
    assert.equal(fromLamports(1000000000, 9), 1);
  });

  it('handles fractional values', () => {
    assert.equal(fromLamports(1500000, 6), 1.5);
  });
});

describe('toLamports', () => {
  it('converts 1 USDC to 1_000_000 lamports', () => {
    assert.equal(toLamports(1, 6), 1000000);
  });

  it('converts 1 SOL to 1_000_000_000 lamports', () => {
    assert.equal(toLamports(1, 9), 1000000000);
  });

  it('floors fractional lamports', () => {
    // 1.9999999 * 1e6 = 1999999.9 → floors to 1999999
    assert.equal(toLamports(1.9999999, 6), 1999999);
  });

  it('roundtrip: toLamports then fromLamports = original within 1 unit', () => {
    const amount   = 123.456789;
    const lamports = toLamports(amount, 6);
    const back     = fromLamports(lamports, 6);
    // toLamports floors, so back ≤ original, diff < 0.000001
    assert.ok(Math.abs(back - amount) < 0.000001);
  });
});
