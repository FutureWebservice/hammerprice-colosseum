/**
 * One-time (and re-runnable) devnet setup. Idempotent: every step first asks the chain whether it is already done.
 *
 *   npm run devnet:bootstrap -- [--cards 8] [--env]
 *
 * 1. reads the role keys from ~/.hammerprice/devnet-keys.json (override with HP_KEYS_FILE) and creates that file with fresh keys (mode 600)
 *    when it does not exist; prints PUBLIC keys only;
 * 2. checks the SETTLEMENT_AUTHORITY devnet balance. When it is below what this run needs it makes ONE airdrop attempt, and if that
 *    does not help it STOPS and tells the human how much SOL to send to which public key (exit code 2). No faucet loop, ever;
 * 3. creates the test USDC mint (6 decimals, mint authority FAUCET_MINT_AUTHORITY), the "Hammerprice Devnet Vault" Core collection
 *    and the house replica cards (recorded in devnet_assets);
 * 4. prints the public env lines to add. The three secret env lines are printed only with --env (throwaway devnet keys, for your own
 *    .env.local; never paste them anywhere else).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { addressesFor, connectionIo, devnetUrl, ensureCollection, ensureUsdcMint, FundingError, keysFilePath, loadRoleKeys, neededLamports, requireFunds, ROLE_NAMES } from '@/lib/chain/replica-mint';
import { loadScriptEnv } from './env';
import { mintHouseInventory } from './mint-house-inventory';

/** First run: four fresh devnet keypairs in the keys file, readable by the owner only. */
function ensureKeysFile(file: string) {
  if (fs.existsSync(file)) return;
  const out: Record<string, { publicKey: string; secretKey: number[] }> = {};
  for (const name of ROLE_NAMES) { const kp = Keypair.generate(); out[name] = { publicKey: kp.publicKey.toBase58(), secretKey: [...kp.secretKey] }; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(`created ${file} with four new devnet keypairs`);
}

async function main() {
  loadScriptEnv();
  ensureKeysFile(keysFilePath());
  const i = process.argv.indexOf('--cards');
  const cards = i >= 0 ? Number(process.argv[i + 1]) : 8;
  if (!Number.isInteger(cards) || cards < 0 || cards > 60) throw new Error('--cards must be an integer from 0 to 60');
  const k = loadRoleKeys();
  const a = addressesFor(k.sa);
  const conn = new Connection(devnetUrl(), 'confirmed');
  const io = connectionIo(conn);

  console.log('public keys (devnet):');
  console.log(`  settlement authority  ${k.sa.publicKey.toBase58()}   (pays fees and rent, third signer, no authority over any asset)`);
  console.log(`  house seller          ${k.house.publicKey.toBase58()}`);
  console.log(`  faucet mint authority ${k.faucet.publicKey.toBase58()}`);
  console.log(`  fee wallet            ${k.feeWallet.toBase58()}`);
  console.log(`  SA balance            ${(Number(await io.getBalance(k.sa.publicKey)) / 1e9).toFixed(4)} SOL`);

  try { await requireFunds(io, k.sa.publicKey, await neededLamports(io, k, { cards }), conn); } catch (e) { if (e instanceof FundingError) { console.error('\n' + e.message); process.exit(2); } throw e; }

  const mint = await ensureUsdcMint(io, k);
  console.log(`test USDC mint        ${mint.mint.toBase58()}  (${mint.created ? 'created' : 'already existed'})`);
  const coll = await ensureCollection(io, k);
  console.log(`vault collection      ${coll.collection.toBase58()}  (${coll.created ? 'created' : 'already existed'})`);
  if (cards > 0) await mintHouseInventory(io, k, cards);

  console.log('\nadd these PUBLIC lines to the environment (.env.local):');
  console.log(`USDC_MINT=${a.usdcMint.toBase58()}`);
  console.log(`NEXT_PUBLIC_USDC_MINT=${a.usdcMint.toBase58()}`);
  console.log(`PLATFORM_WALLET_ADDRESS=${k.feeWallet.toBase58()}`);
  console.log(`NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS=${k.feeWallet.toBase58()}`);
  console.log(`DEVNET_COLLECTION_ADDRESS=${a.collection.toBase58()}`);
  if (process.argv.includes('--env')) {
    const j = JSON.parse(fs.readFileSync(keysFilePath(), 'utf8')) as Record<string, { secretKey: number[] }>;
    console.log('\nsecret lines for your own .env.local (devnet keys only):');
    for (const [name, role] of [['SETTLEMENT_AUTHORITY_SECRET_KEY', 'SETTLEMENT_AUTHORITY'], ['HOUSE_SELLER_SECRET_KEY', 'HOUSE_SELLER'], ['FAUCET_MINT_AUTHORITY_SECRET_KEY', 'FAUCET_MINT_AUTHORITY']]) console.log(`${name}=${JSON.stringify(j[role].secretKey)}`);
  } else console.log('\nThe three secret keys (SETTLEMENT_AUTHORITY_SECRET_KEY, HOUSE_SELLER_SECRET_KEY, FAUCET_MINT_AUTHORITY_SECRET_KEY) are not printed; add --env to print them for your .env.local.');
  process.exit(0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
