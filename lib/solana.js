'use strict';

// ─── USDC mint address on Solana (mainnet) ────────────────────────────────────
const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

/**
 * Parse Birdeye OHLCV API response into standard candle format.
 * Birdeye endpoint: GET /defi/ohlcv?address=...&type=4H&time_from=...&time_to=...
 * @param {Object} birdeyeResponse - Raw API response
 * @returns {Array<{timestamp, open, high, low, close, volume}>}
 */
function parseBirdeyeOHLCV(birdeyeResponse) {
  if (!birdeyeResponse?.data?.items?.length) {
    throw new Error('parseBirdeyeOHLCV: empty or invalid response');
  }
  return birdeyeResponse.data.items.map(c => ({
    timestamp: new Date(c.unixTime * 1000).toISOString(),
    open:      parseFloat(c.open),
    high:      parseFloat(c.high),
    low:       parseFloat(c.low),
    close:     parseFloat(c.close),
    volume:    parseFloat(c.volume)
  }));
}

/**
 * Build Birdeye OHLCV request URL for the last N candles.
 * @param {string} tokenAddress - Solana token mint address
 * @param {string} interval     - e.g. '4H', '1H', '15m'
 * @param {number} candleCount  - number of candles to fetch (default 200)
 * @returns {{url: string, headers: Object}}
 */
function buildBirdeyeOHLCVRequest(tokenAddress, interval = '4H', candleCount = 200) {
  const intervalSeconds = {
    '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
    '1H': 3600, '4H': 14400, '1D': 86400
  };
  const secs = intervalSeconds[interval] || 14400;
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - (secs * candleCount);

  return {
    url: `https://public-api.birdeye.so/defi/ohlcv?address=${tokenAddress}&type=${interval}&time_from=${timeFrom}&time_to=${now}`,
    headers: {
      'X-API-KEY': null, // set from env in workflow
      'x-chain': 'solana'
    }
  };
}

/**
 * Build Jupiter Quote API URL.
 * Converts positionSizeUsdt → USDC lamports → Jupiter quote.
 * @param {string} outputMint     - Token to buy
 * @param {number} positionUsdt   - Position size in USD
 * @param {number} slippageBps    - Slippage in basis points (50 = 0.5%)
 * @returns {string} URL
 */
function buildJupiterQuoteUrl(outputMint, positionUsdt, slippageBps = 50) {
  const amountLamports = Math.floor(positionUsdt * Math.pow(10, USDC_DECIMALS));
  return `https://quote-api.jup.ag/v6/quote?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}&platformFeeBps=0`;
}

/**
 * Build Jupiter Quote URL for SELLING a token (close position).
 * @param {string} inputMint      - Token to sell
 * @param {number} tokenAmount    - Amount of tokens (in token units, not lamports)
 * @param {number} tokenDecimals  - Token decimals (usually 6 or 9)
 * @param {number} slippageBps
 * @returns {string} URL
 */
function buildJupiterSellUrl(inputMint, tokenAmount, tokenDecimals, slippageBps = 100) {
  const amountLamports = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));
  return `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${USDC_MINT}&amount=${amountLamports}&slippageBps=${slippageBps}`;
}

/**
 * Calculate recommended slippage based on position size vs pool liquidity.
 * Larger position relative to liquidity = higher slippage needed.
 * @param {number} positionUsdt
 * @param {number} liquidityUsdt  - Pool liquidity from Birdeye
 * @returns {number} slippageBps
 */
function calcDynamicSlippage(positionUsdt, liquidityUsdt) {
  if (!liquidityUsdt || liquidityUsdt <= 0) return 200; // unknown liquidity → conservative
  const impact = positionUsdt / liquidityUsdt;
  if (impact < 0.001) return 30;   // < 0.1% of pool → 0.3%
  if (impact < 0.005) return 50;   // < 0.5% of pool → 0.5%
  if (impact < 0.01)  return 100;  // < 1% of pool   → 1%
  if (impact < 0.02)  return 200;  // < 2% of pool   → 2%
  return 300;                       // > 2% → 3% (or skip trade)
}

/**
 * Parse Jupiter swap quote response — extract key execution info.
 * @param {Object} quoteResponse - Jupiter /v6/quote response
 * @returns {{ inputAmount, outputAmount, priceImpactPct, slippageBps }}
 */
function parseJupiterQuote(quoteResponse) {
  if (!quoteResponse?.outAmount) {
    throw new Error('parseJupiterQuote: invalid quote response');
  }
  return {
    inputMint:       quoteResponse.inputMint,
    outputMint:      quoteResponse.outputMint,
    inputAmount:     parseInt(quoteResponse.inAmount),
    outputAmount:    parseInt(quoteResponse.outAmount),
    priceImpactPct:  parseFloat(quoteResponse.priceImpactPct || 0),
    slippageBps:     quoteResponse.slippageBps || 50,
    routePlan:       quoteResponse.routePlan?.map(r => r.swapInfo?.label).filter(Boolean)
  };
}

/**
 * Calculate effective entry price from Jupiter quote.
 * inputAmount is in USDC lamports, outputAmount is in token lamports.
 * @param {Object} quote - output of parseJupiterQuote
 * @param {number} tokenDecimals
 * @returns {number} price in USDC per token
 */
function calcEffectivePrice(quote, tokenDecimals) {
  const inputUsdc   = quote.inputAmount / Math.pow(10, USDC_DECIMALS);
  const outputToken = quote.outputAmount / Math.pow(10, tokenDecimals);
  return outputToken > 0 ? inputUsdc / outputToken : 0;
}

/**
 * Convert token lamports to human-readable amount.
 * @param {number} lamports
 * @param {number} decimals
 * @returns {number}
 */
function fromLamports(lamports, decimals) {
  return lamports / Math.pow(10, decimals);
}

/**
 * Convert human-readable token amount to lamports.
 * @param {number} amount
 * @param {number} decimals
 * @returns {number} integer lamports
 */
function toLamports(amount, decimals) {
  return Math.floor(amount * Math.pow(10, decimals));
}

module.exports = {
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
};
