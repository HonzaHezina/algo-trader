'use strict';

/**
 * Round a number to a specified number of decimal places
 */
function roundTo(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Format a USD amount for display
 */
function formatUSD(amount) {
  const rounded = roundTo(amount, 2);
  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format a percentage for display (0.042 → "+4.20%")
 */
function formatPct(value, decimals = 2) {
  const pct = roundTo(value * 100, decimals);
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

/**
 * Build Telegram trade card message with inline approve/reject buttons.
 * @param {Object} tradeCard - Analyst output
 * @returns {{ text: string, reply_markup: Object }}
 */
function buildTradeCardMessage(tradeCard) {
  const {
    coin, direction, entry_price, stop_loss,
    position_size_usdt, risk_amount_usdt,
    confidence_score, reasoning, signal_id,
    trailing_atr_mult, trail_activation_pct
  } = tradeCard;

  const dirIcon   = direction === 'long' ? '🟢' : '🔴';
  const dirLabel  = direction === 'long' ? 'LONG' : 'SHORT';
  const riskPct   = roundTo((Math.abs(entry_price - stop_loss) / entry_price) * 100, 2);
  const confPct   = roundTo(confidence_score * 100, 0);
  const shortId   = signal_id.slice(0, 8);

  const text = [
    `${dirIcon} *${dirLabel} Setup — ${coin}*`,
    ``,
    `💰 Entry: \`${entry_price}\``,
    `🛑 Stop Loss: \`${stop_loss}\` (-${riskPct}%)`,
    `📈 Trailing Stop: ${trailing_atr_mult}× ATR (aktivuje po +${roundTo(trail_activation_pct * 100, 0)}%)`,
    `📊 Pozice: ${formatUSD(position_size_usdt)}`,
    `⚠️  Risk: ${formatUSD(risk_amount_usdt)}`,
    `🎯 Confidence: ${confPct}%`,
    ``,
    `💬 _${reasoning}_`,
    ``,
    `ID: \`${shortId}\``
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve_${signal_id}` },
      { text: '❌ Reject',  callback_data: `reject_${signal_id}` }
    ]]
  };

  return { text, reply_markup };
}

/**
 * Build Telegram portfolio status message.
 * @param {Object} portfolio - Portfolio row from DB
 * @param {Array}  openTrades - Open trades from DB
 * @returns {string}
 */
function buildStatusMessage(portfolio, openTrades = []) {
  const {
    total_value, total_pnl_usdt, total_pnl_pct,
    today_pnl_usdt, total_trades, winning_trades,
    losing_trades, consecutive_losses, system_active
  } = portfolio;

  const winRate    = total_trades > 0 ? roundTo((winning_trades / total_trades) * 100, 1) : 0;
  const sysIcon    = system_active ? '⚡ AKTIVNÍ' : '⛔ ZASTAVEN';
  const totalSign  = total_pnl_usdt >= 0 ? '+' : '';
  const todaySign  = today_pnl_usdt >= 0 ? '+' : '';
  const pnlIcon    = total_pnl_usdt >= 0 ? '📈' : '📉';

  let tradesSection;
  if (openTrades.length > 0) {
    const lines = openTrades.map(t => {
      const icon   = t.direction === 'long' ? '🟢' : '🔴';
      const pnl    = parseFloat(t.pnl_usdt || 0);
      const pnlStr = pnl >= 0 ? `+${formatUSD(pnl)}` : formatUSD(pnl);
      return `  ${icon} ${t.coin} ${t.direction.toUpperCase()} @ ${t.entry_price}\n     Stop: ${t.current_stop} | P&L: ${pnlStr}`;
    });
    tradesSection = `\n📂 *Otevřené pozice: ${openTrades.length}/3*\n${lines.join('\n')}\n`;
  } else {
    tradesSection = '\n📂 *Otevřené pozice: 0/3*\n';
  }

  return [
    `📊 *Portfolio Status*`,
    ``,
    `💰 Kapitál: ${formatUSD(total_value)}`,
    `${pnlIcon} Celkový P&L: ${totalSign}${formatUSD(total_pnl_usdt)} (${totalSign}${roundTo(parseFloat(total_pnl_pct), 2)}%)`,
    `📅 Dnes: ${todaySign}${formatUSD(today_pnl_usdt)}`,
    tradesSection,
    `📊 Win Rate: ${winRate}% (${winning_trades}W / ${losing_trades}L)`,
    `🔴 Consecutive losses: ${consecutive_losses}`,
    `⚡ Systém: ${sysIcon}`
  ].join('\n');
}

/**
 * Validate that a value is a finite positive number
 */
function isValidPrice(value) {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

/**
 * Calculate HMAC SHA256 signature for Binance API
 * @param {string} queryString - URL-encoded query string
 * @param {string} secret - Binance API secret
 * @returns {string}
 */
function createBinanceSignature(queryString, secret) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Build Binance signed order params
 * @param {string} symbol
 * @param {string} side   - BUY | SELL
 * @param {string} type   - MARKET
 * @param {Object} extra  - e.g. { quoteOrderQty: 390 } or { quantity: 2.73 }
 * @param {string} secret - Binance API secret
 * @returns {{ queryString, signature }}
 */
function buildBinanceSignedOrder(symbol, side, type, extra, secret) {
  const timestamp = Date.now();
  const extraStr  = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join('&');
  const queryString = `symbol=${symbol}&side=${side}&type=${type}&${extraStr}&timestamp=${timestamp}`;
  const signature   = createBinanceSignature(queryString, secret);
  return { queryString, signature };
}

/**
 * Extract JSON from OpenClaw agent response content.
 * OpenClaw returns plain text; the agent should return JSON in the message.
 * @param {string} content - OpenClaw response message content
 * @returns {Object} - Parsed JSON
 */
function extractAgentJSON(content) {
  // Try direct parse first
  try {
    return JSON.parse(content.trim());
  } catch (_) {
    // Find JSON block in markdown
    const match = content.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    // Find first { to last }
    const start = content.indexOf('{');
    const end   = content.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw new Error(`Cannot extract JSON from agent response: ${content.slice(0, 200)}`);
  }
}

/**
 * Sleep for ms milliseconds (use sparingly)
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  roundTo,
  formatUSD,
  formatPct,
  buildTradeCardMessage,
  buildStatusMessage,
  isValidPrice,
  createBinanceSignature,
  buildBinanceSignedOrder,
  extractAgentJSON,
  sleep
};
