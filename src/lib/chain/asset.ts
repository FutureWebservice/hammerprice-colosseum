/**
 * Reading an asset and deciding whether it can be consigned (owner == seller, plain owner transfer allowed).
 *
 * `readAsset` decodes the ACCOUNT (the same bytes the Core program checks), never a cached index: a consign or a
 * settlement must not be decided on an indexer's lag. DAS (das.ts) only feeds the seller's picker.
 */
import { PublicKey } from '@solana/web3.js';
import { deserializeAssetV1, deserializeCollectionV1 } from '@metaplex-foundation/mpl-core';
import { publicKey as umiPk } from '@metaplex-foundation/umi';
import type { AssetInfo, AssetReadiness, Cluster, ReadinessReason } from '@/contracts';
import { resolveCluster } from './config';
import { CORE_PROGRAM_ID, TOKEN_PROGRAM_ID } from './ix';
import { getAccount, getMultipleAccounts, makeRpc, type RawAccount, type RpcCall } from './rpc';

const SOL = { basisPoints: 1n, identifier: 'SOL' as const, decimals: 9 as const };
const rpcAccount = (address: string, a: RawAccount) => ({
  publicKey: umiPk(address), owner: umiPk(a.owner), lamports: SOL, data: a.data, executable: false, rentEpoch: 0n,
  header: { executable: false, owner: umiPk(a.owner), lamports: SOL, rentEpoch: 0n },
});

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Collector Crypt and DAS spell the standard differently ('cnft-v2', 'ERC721', 'MplCoreAsset'); ours has five values. */
export function normalizeStandard(s: string | null | undefined): AssetInfo['standard'] {
  switch ((s ?? '').toLowerCase()) {
    case 'core': case 'mplcoreasset': return 'core';
    case 'pnft': case 'programmablenft': return 'pnft';
    case 'nft': return 'nft';
    case 'cnft': case 'cnft-v2': return 'cnft';
    default: return 'unknown';
  }
}

const isNone = (rs: Loose | undefined) => !rs || (rs.type ?? rs.__kind) === 'None';
/** Any adapter that can veto a transfer (Oracle, LifecycleHook) makes the outcome depend on a third party: refuse. */
const transferVeto = (list: Loose[] | undefined): string | null => {
  for (const p of list ?? []) if ((p.lifecycleChecks?.transfer?.length ?? 0) > 0) return String(p.baseAddress ?? 'unknown');
  return null;
};

/** The plugin facts of one Core account (asset or collection) that decide whether an owner transfer works. */
function pluginFacts(a: Loose) {
  return {
    frozen: Boolean(a.freezeDelegate?.frozen || a.permanentFreezeDelegate?.frozen),
    royaltyBlocks: Boolean(a.royalties && !isNone(a.royalties.ruleSet)),
    veto: transferVeto(a.oracles) ?? transferVeto(a.lifecycleHooks) ?? transferVeto(a.linkedLifecycleHooks),
  };
}

/**
 * Turns raw account bytes into an AssetInfo. Pure (tests feed it real mainnet bytes). `collectionAccount` is the asset's
 * collection account when it has one: collection-level plugins apply to every asset in it, so they count too
 * (conservative: a block on either level blocks).
 */
export function decodeAssetAccount(mint: string, account: RawAccount | null, collectionAccount: RawAccount | null = null): AssetInfo | null {
  if (!account) return null;
  const base = { mint, owner: null, collection: null, name: '', imageUrl: null, frozen: false, compressed: false, burnt: false, royaltyBlocksOwnerTransfer: false, blockingDelegate: null };
  if (account.owner === TOKEN_PROGRAM_ID.toBase58()) {
    // A mint account: a pNFT or a plain NFT (indistinguishable without the metadata account; both unsupported).
    return { ...base, standard: 'nft' };
  }
  if (account.owner !== CORE_PROGRAM_ID.toBase58()) return { ...base, standard: 'unknown' };
  if (account.data.length === 0 || account.data[0] === 0) return { ...base, standard: 'core', burnt: true }; // Key::Uninitialized: burnt
  const a = deserializeAssetV1(rpcAccount(mint, account) as never) as Loose;
  const facts = pluginFacts(a);
  const collection: string | null = a.updateAuthority?.type === 'Collection' ? String(a.updateAuthority.address) : null;
  let cf = { frozen: false, royaltyBlocks: false, veto: null as string | null };
  if (collectionAccount && collection) {
    cf = pluginFacts(deserializeCollectionV1(rpcAccount(collection, collectionAccount) as never) as Loose);
  }
  return {
    mint, standard: 'core', owner: String(a.owner), collection, name: String(a.name ?? ''), imageUrl: null,
    frozen: facts.frozen || cf.frozen, compressed: false, burnt: false,
    royaltyBlocksOwnerTransfer: facts.royaltyBlocks || cf.royaltyBlocks,
    blockingDelegate: facts.veto ?? cf.veto,
  };
}

/** Account read (+ the collection account when the asset has one). null = no such account. Throws ChainError('rpc_unavailable'). */
export async function readAsset(mint: string, cluster: Cluster = resolveCluster(), call: RpcCall = makeRpc(cluster)): Promise<AssetInfo | null> {
  try { new PublicKey(mint); } catch { return null; }
  const account = await getAccount(call, mint);
  const first = decodeAssetAccount(mint, account);
  if (!account || !first?.collection) return first;
  return decodeAssetAccount(mint, account, await getAccount(call, first.collection));
}

/**
 * Eligible only when it is a Core asset the seller owns that a plain owner transfer can move. A foreign TransferDelegate
 * (for example a Collector Crypt listing PDA) does not block an owner transfer, so it is not a reason.
 * `null` (no account) is `not_found`; pNFT, cNFT, plain NFT and EVM are `unsupported_standard` and nothing else is said about them.
 */
export function evaluateAssetReadiness(info: AssetInfo | null, ctx: { seller: string }): AssetReadiness {
  const reasons: ReadinessReason[] = [];
  if (!info || info.burnt) reasons.push('not_found');
  else if (info.standard !== 'core' || info.compressed) reasons.push('unsupported_standard');
  else {
    if (info.owner !== ctx.seller) reasons.push('not_owner');
    if (info.frozen) reasons.push('frozen');
    if (info.royaltyBlocksOwnerTransfer) reasons.push('royalty_rules_block_transfer');
    if (info.blockingDelegate) reasons.push('foreign_delegate_blocks');
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * `readAsset` for many mints in two requests however many there are (getMultipleAccounts: the asset accounts, then the distinct
 * collection accounts), so a page read that checks a whole candidate list stays inside a public RPC's rate limit.
 * The result lines up with `mints`; an invalid address or a missing account is null. Throws ChainError('rpc_unavailable').
 */
export async function readAssets(mints: string[], cluster: Cluster = resolveCluster(), call: RpcCall = makeRpc(cluster)): Promise<(AssetInfo | null)[]> {
  const valid = mints.map((m) => { try { new PublicKey(m); return true; } catch { return false; } });
  const ask = mints.filter((_, i) => valid[i]);
  const accounts = ask.length ? await getMultipleAccounts(call, ask) : [];
  const first = ask.map((m, i) => decodeAssetAccount(m, accounts[i] ?? null));
  const collections = [...new Set(first.map((f, i) => (accounts[i] && f?.collection ? f.collection : null)).filter((c): c is string => c !== null))];
  const collectionAccounts = new Map(collections.map((c, i) => [c, i] as const));
  const fetched = collections.length ? await getMultipleAccounts(call, collections) : [];
  const decoded = new Map(ask.map((m, i) => {
    const f = first[i];
    const info = accounts[i] && f?.collection ? decodeAssetAccount(m, accounts[i]!, fetched[collectionAccounts.get(f.collection)!] ?? null) : f;
    return [m, info] as const;
  }));
  return mints.map((m, i) => (valid[i] ? decoded.get(m) ?? null : null));
}
