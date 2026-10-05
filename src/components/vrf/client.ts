/**
 * Browser-side helpers of the draw UI: the three API calls and the verifier. The verifier (lib/vrf, curve code included) is loaded on
 * demand with a dynamic import, so a page that never shows a proof does not pay for it. Everything takes `fetch` as a parameter so the
 * tests need no network.
 */
import type { z } from 'zod';
import type { Cluster, VrfKeyResponse } from '@/contracts';
import { rpcEndpoint } from '@/lib/auth/config';
import { clientCluster } from '@/lib/client/cluster-text';
import type { Check, VrfRequestView } from '@/lib/vrf';

type F = typeof fetch;
export type KeyInfo = z.infer<typeof VrfKeyResponse>;
export type Loaded<T> = { kind: 'ok'; value: T } | { kind: 'not_found' } | { kind: 'off' } | { kind: 'error' };

async function read<T>(res: Response): Promise<Loaded<T>> {
  if (res.status === 404) {
    const code = (await res.json().catch(() => ({}))) as { code?: string };
    return code.code === 'feature_off' ? { kind: 'off' } : { kind: 'not_found' };
  }
  if (!res.ok) return { kind: 'error' };
  return { kind: 'ok', value: (await res.json()) as T };
}

export async function fetchRequest(id: string, f: F = fetch): Promise<Loaded<VrfRequestView>> {
  try { return await read<VrfRequestView>(await f(`/api/vrf/requests/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })); } catch { return { kind: 'error' }; }
}

/** Public and idempotent: asks the server to move the draw along and returns its view. */
export async function postAdvance(id: string, f: F = fetch): Promise<Loaded<VrfRequestView>> {
  try {
    return await read<VrfRequestView>(await f(`/api/vrf/requests/${encodeURIComponent(id)}/advance`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' }));
  } catch { return { kind: 'error' }; }
}

export async function fetchKey(f: F = fetch): Promise<Loaded<KeyInfo>> {
  try { return await read<KeyInfo>(await f('/api/vrf/key', { headers: { accept: 'application/json' } })); } catch { return { kind: 'error' }; }
}

export async function fetchShowDraws(showId: string, f: F = fetch): Promise<{ lotOrder: { requestId: string; status: string } | null; raffle: { requestId: string; status: string } | null } | null> {
  try {
    const r = await f(`/api/vrf/shows/${encodeURIComponent(showId)}`, { headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** The names of a show's lots by id (the draw only knows ids), from the public catalogue. Empty when unavailable. */
export async function fetchLotNames(showId: string, f: F = fetch): Promise<Record<string, string>> {
  try {
    const r = await f(`/api/shows/${encodeURIComponent(showId)}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return {};
    const body = (await r.json()) as { lots?: { id: string; name: string }[] };
    return Object.fromEntries((body.lots ?? []).map((l) => [l.id, l.name]));
  } catch { return {}; }
}

/**
 * Where the chain checks read: the deployment's public RPC for its own cluster, the public endpoint of the cluster otherwise (a draw of
 * the other network). Literal env read so Next inlines it; no key ever reaches the browser.
 */
export const rpcUrlFor = (cluster: Cluster): string => rpcEndpoint(cluster, cluster === clientCluster() ? process.env.NEXT_PUBLIC_SOLANA_RPC_PUBLIC : null);

/** The five cryptographic rules only: no network, the verdict "proven" rests on these. */
export async function runCrypto(view: VrfRequestView): Promise<Check[]> {
  const v = await import('@/lib/vrf');
  return v.verifyCrypto(view);
}

/** All nine rules; the last four read the chain through the cluster's public RPC. */
export async function runAll(view: VrfRequestView, f: F = fetch): Promise<Check[]> {
  const v = await import('@/lib/vrf');
  return v.verifyRequest(view, { rpc: v.createFetchRpc(rpcUrlFor(view.cluster), { fetch: f }) });
}

export async function provenLocally(checks: readonly Check[]): Promise<boolean> {
  return (await import('@/lib/vrf')).isLocallyProven(checks);
}

/** The text of the proof package a visitor can keep (everything public, nothing else). */
export const proofPackage = (view: VrfRequestView, checks: readonly Check[] | null): string =>
  JSON.stringify({ format: 'hammerprice-vrf-proof', version: 1, request: view, checks: checks ?? undefined }, null, 2);
