/**
 * Digital Asset Standard (indexer) reads: the seller's "your cards" picker. Needs an indexer endpoint (DAS_RPC_URL);
 * the public devnet RPC has none, and devnet replicas come from the devnet_assets table instead.
 *
 * DAS is an INDEX and can lag: never decide a consign or a settlement from it. `readAsset` (asset.ts) reads the account.
 * The mapping follows the documented DAS item shape (interface, ownership, compression, burnt, grouping, plugins).
 */
import type { AssetInfo, Cluster } from '@/contracts';
import { AssetInfo as AssetInfoSchema } from '@/contracts';
import { dasUrl } from './config';
import { ChainError } from './errors';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const standardOf = (item: Loose): AssetInfo['standard'] => {
  if (item.compression?.compressed) return 'cnft';
  switch (item.interface) {
    case 'MplCoreAsset': return 'core';
    case 'ProgrammableNFT': return 'pnft';
    case 'V1_NFT': case 'V1_PRINT': case 'LEGACY_NFT': return 'nft';
    default: return 'unknown';
  }
};

const isNone = (rs: unknown) => rs === undefined || rs === null || rs === 'None' || (typeof rs === 'object' && Object.keys(rs as object).length === 1 && 'None' in (rs as object));

/** One DAS item to the AssetInfo shape. Returns null when the item has no usable id. */
export function dasItemToAssetInfo(item: Loose): AssetInfo | null {
  if (typeof item?.id !== 'string') return null;
  const plugins: Loose = item.plugins ?? {};
  const frozen = Boolean(item.ownership?.frozen || plugins.freeze_delegate?.data?.frozen || plugins.permanent_freeze_delegate?.data?.frozen);
  const collection = (item.grouping ?? []).find((g: Loose) => g.group_key === 'collection')?.group_value ?? null;
  const vetoing = ['oracles', 'lifecycle_hooks'].some((k) => Array.isArray(plugins[k]) ? plugins[k].length > 0 : Boolean(plugins[k]));
  return AssetInfoSchema.parse({
    mint: item.id,
    standard: standardOf(item),
    owner: item.ownership?.owner ?? null,
    collection,
    name: String(item.content?.metadata?.name ?? ''),
    imageUrl: item.content?.links?.image ?? item.content?.files?.[0]?.uri ?? null,
    frozen,
    compressed: Boolean(item.compression?.compressed),
    burnt: Boolean(item.burnt),
    royaltyBlocksOwnerTransfer: Boolean(plugins.royalties) && !isNone(plugins.royalties?.data?.rule_set),
    blockingDelegate: vetoing ? 'unknown-adapter' : null,
  });
}

async function dasCall<T>(method: string, params: unknown, fetchImpl: typeof fetch = globalThis.fetch): Promise<T> {
  const url = dasUrl();
  if (!url) throw new ChainError('rpc_unavailable', 'no DAS endpoint configured (DAS_RPC_URL)');
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (!res.ok || body.error || body.result === undefined) throw new Error('das error');
    return body.result;
  } catch {
    throw new ChainError('rpc_unavailable', 'the asset index is unavailable');
  }
}

/** Every asset a wallet owns (optionally inside one collection), one page of up to 100. */
export async function assetsByOwner(owner: string, opts: { collection?: string; page?: number; fetch?: typeof fetch } = {}): Promise<AssetInfo[]> {
  const params: Loose = { ownerAddress: owner, page: opts.page ?? 1, limit: 100 };
  if (opts.collection) params.grouping = ['collection', opts.collection];
  const r = await dasCall<{ items: Loose[] }>('searchAssets', params, opts.fetch);
  return r.items.map(dasItemToAssetInfo).filter((x): x is AssetInfo => x !== null);
}

export async function getAssetDas(id: string, _cluster?: Cluster, fetchImpl?: typeof fetch): Promise<AssetInfo | null> {
  return dasItemToAssetInfo(await dasCall<Loose>('getAsset', { id }, fetchImpl));
}
