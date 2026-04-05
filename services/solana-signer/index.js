'use strict';

/**
 * Solana Signer Microservice
 * Podepisuje a odesílá Jupiter swap transakce na Solana mainnet.
 *
 * Endpoints:
 *   GET  /health           — stav služby + veřejný klíč peněženky
 *   GET  /balance          — SOL + USDC zůstatky
 *   POST /sign-and-send    — podepíše base64 tx z Jupiter /v6/swap a odešle
 *
 * Env:
 *   SOLANA_PRIVATE_KEY  — base58 private key (64 bytes)
 *   SOLANA_RPC_URL      — Solana RPC endpoint (mainnet-beta nebo QuickNode)
 *   SIGNER_PORT         — port (default 3001)
 *   CONFIRMATION_LEVEL  — 'confirmed' | 'finalized' (default 'confirmed')
 */

const express = require('express');
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const bs58 = require('bs58');

// ─── Konfigurace ──────────────────────────────────────────────────────────────

const PRIVATE_KEY_B58 = process.env.SOLANA_PRIVATE_KEY;
const RPC_URL         = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT            = parseInt(process.env.SIGNER_PORT || '3001');
const CONFIRM_LEVEL   = process.env.CONFIRMATION_LEVEL || 'confirmed';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ─── Inicializace ─────────────────────────────────────────────────────────────

if (!PRIVATE_KEY_B58) {
  console.error('[signer] FATAL: SOLANA_PRIVATE_KEY is not set');
  process.exit(1);
}

let keypair;
try {
  keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
} catch (err) {
  console.error('[signer] FATAL: invalid SOLANA_PRIVATE_KEY:', err.message);
  process.exit(1);
}

const connection = new Connection(RPC_URL, CONFIRM_LEVEL);
const publicKey  = keypair.publicKey;

console.log(`[signer] Wallet: ${publicKey.toBase58()}`);
console.log(`[signer] RPC:    ${RPC_URL}`);

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    ok:         true,
    wallet:     publicKey.toBase58(),
    rpc:        RPC_URL,
    timestamp:  new Date().toISOString()
  });
});

// ─── GET /balance ─────────────────────────────────────────────────────────────

app.get('/balance', async (_req, res) => {
  try {
    // SOL balance
    const lamports = await connection.getBalance(publicKey);
    const sol      = lamports / LAMPORTS_PER_SOL;

    // USDC balance (SPL token)
    let usdc = 0;
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { mint: new PublicKey(USDC_MINT) }
      );
      if (tokenAccounts.value.length > 0) {
        usdc = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
      }
    } catch {
      // USDC token account nemusí existovat při nulovém zůstatku
    }

    res.json({ ok: true, sol, usdc, wallet: publicKey.toBase58() });
  } catch (err) {
    console.error('[signer] /balance error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /sign-and-send ──────────────────────────────────────────────────────

/**
 * Body: { swapTransaction: "<base64 versioned transaction from Jupiter>" }
 * Response: { ok: true, signature: "...", explorerUrl: "..." }
 */
app.post('/sign-and-send', async (req, res) => {
  const { swapTransaction } = req.body || {};

  if (!swapTransaction || typeof swapTransaction !== 'string') {
    return res.status(400).json({ ok: false, error: 'swapTransaction (base64) is required' });
  }

  try {
    // 1. Deserializace Jupiter VersionedTransaction
    const txBytes = Buffer.from(swapTransaction, 'base64');
    const tx      = VersionedTransaction.deserialize(txBytes);

    // 2. Podpis
    tx.sign([keypair]);

    // 3. Odeslání na RPC
    const rawTx = tx.serialize();
    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight:       false,
      maxRetries:          3,
      preflightCommitment: CONFIRM_LEVEL
    });

    // 4. Potvrzení
    const confirmation = await connection.confirmTransaction(
      { signature, ...await connection.getLatestBlockhash() },
      CONFIRM_LEVEL
    );

    if (confirmation.value.err) {
      console.error('[signer] tx failed:', confirmation.value.err);
      return res.status(500).json({
        ok:        false,
        error:     'Transaction failed on-chain',
        signature,
        txError:   JSON.stringify(confirmation.value.err)
      });
    }

    console.log(`[signer] tx confirmed: ${signature}`);
    res.json({
      ok:          true,
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`
    });

  } catch (err) {
    console.error('[signer] /sign-and-send error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[signer] Listening on port ${PORT}`);
});
