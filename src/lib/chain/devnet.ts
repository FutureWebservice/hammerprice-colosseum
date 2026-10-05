/**
 * Devnet-only plumbing: the stable test addresses, the instruction builders behind the test-USDC faucet and the
 * demo-card mint, and a small sender over RPC. Shared by the routes (src/server/settlement/devnet.ts) and the scripts.
 *
 * Nothing here knows a route or a database. Key material comes in as arguments; no secret is logged or returned.
 */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, createSignerFromKeypair, publicKey as umiPk, signerIdentity } from '@metaplex-foundation/umi';
import { create, mplCore } from '@metaplex-foundation/mpl-core';
import { fromWeb3JsKeypair, toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { ChainError } from './errors';
import { ataAddress, createAtaIdempotentIx, mintToIx } from './ix';
import { classifySendFailure } from './port';
import { getBalanceLamports, getLatestBlockhash, getSignatureStatus, RpcError, sendTransaction, type RpcCall } from './rpc';

/** 1,000 test USDC (6 decimals) per faucet request. */
export const FAUCET_AMOUNT = 1_000_000_000n;
/** The faucet and the card mint pause below 0.5 SOL on the settlement authority: what is left must cover settlements. */
export const MIN_SA_LAMPORTS = 500_000_000n;

/** A keypair derived from the settlement authority's SECRET, so the test mint and the collection have stable addresses. */
export function derivedKeypair(sa: Keypair, label: string): Keypair {
  return Keypair.fromSeed(createHash('sha256').update(`hammerprice/devnet/${label}/v1`).update(sa.secretKey.slice(0, 32)).digest());
}
/** The "Hammerprice Devnet Vault" collection. Its update authority is SA. */
export const vaultCollection = (sa: Keypair): string => derivedKeypair(sa, 'vault-collection').publicKey.toBase58();

export const umiFor = (payer: PublicKey) => {
  const u = createUmi('http://localhost:9').use(mplCore());
  u.use(signerIdentity(createNoopSigner(umiPk(payer.toBase58()))));
  return u;
};
export const toIxs = (b: { getInstructions(): never[] }) => b.getInstructions().map(toWeb3JsInstruction as never) as TransactionInstruction[];

/** Creates the wallet's USDC account when missing (rent paid by SA) and mints `amount` into it. Signers: SA (fee payer) and the mint authority. */
export function faucetInstructions(a: { sa: PublicKey; mintAuthority: PublicKey; mint: string; wallet: string; amount?: bigint }): TransactionInstruction[] {
  const mint = new PublicKey(a.mint), owner = new PublicKey(a.wallet), ata = ataAddress(mint, owner);
  return [createAtaIdempotentIx(a.sa, ata, owner, mint), mintToIx(mint, ata, a.mintAuthority, a.amount ?? FAUCET_AMOUNT)];
}

/**
 * One Core replica, owned by `owner` from birth, minted into the vault collection with SA as payer and collection authority.
 * The owner does not sign. Signers: SA and the new asset's keypair. The collection carries none of Collector Crypt's permanent
 * delegates: nobody but the owner can move, freeze or burn the card.
 */
export function mintCardInstructions(a: { sa: Keypair; collection: string; asset: Keypair; owner: string; name: string; uri: string; attributes: { trait_type: string; value: string | number }[] }): TransactionInstruction[] {
  const u = umiFor(a.sa.publicKey);
  return toIxs(create(u, {
    asset: createSignerFromKeypair(u, fromWeb3JsKeypair(a.asset)), name: a.name, uri: a.uri, owner: umiPk(a.owner),
    collection: { publicKey: umiPk(a.collection) } as never,
    plugins: [{ type: 'Attributes', attributeList: a.attributes.map((t) => ({ key: t.trait_type, value: String(t.value) })) }],
  }) as never);
}

// ---- sending ------------------------------------------------------------------------------------------------------------

/** What the faucet and the mint need from a chain; LiteSVM implements it in tests, `rpcDevnetIo` in production. */
export interface DevnetIo {
  saLamports(sa: string): Promise<bigint>;
  /** Signs with `payer` (fee payer) and `extra`, sends, waits for `confirmed`, returns the signature. Throws ChainError. */
  send(ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[]): Promise<string>;
}

export function rpcDevnetIo(call: RpcCall, o: { sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): DevnetIo {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs ?? 20_000;
  return {
    saLamports: (sa) => getBalanceLamports(call, sa),
    async send(ixs, payer, extra) {
      const { blockhash } = await getLatestBlockhash(call);
      const tx = new Transaction();
      tx.add(...ixs);
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer, ...extra);
      let sig: string;
      try {
        sig = await sendTransaction(call, tx.serialize().toString('base64'));
      } catch (e) {
        if (e instanceof RpcError) throw new ChainError('rpc_unavailable', classifySendFailure(e.message, ((e.data as { logs?: string[] } | undefined)?.logs) ?? []).message);
        throw e;
      }
      if (sig !== bs58.encode(tx.signatures[0]!.signature!)) throw new ChainError('rpc_unavailable', 'the node returned a different signature');
      for (let waited = 0; waited < waitMs; waited += 1000) {
        const st = await getSignatureStatus(call, sig);
        if (st?.err) throw new ChainError('rpc_unavailable', 'the test network rejected the transaction, try again');
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
        await sleep(1000);
      }
      throw new ChainError('rpc_unavailable', 'the test network is slow and has not confirmed yet, check again in a minute');
    },
  };
}
