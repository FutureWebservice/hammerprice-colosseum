/**
 * Typed fetch wrappers for the seller and account surfaces. The routes live in other agents'
 * directories (contracts/api.ts ROUTES is the agreement); this file only speaks their shapes.
 *
 * Types come from the contracts (type-only imports, so no zod reaches the browser bundle).
 * `PATHS` repeats the route paths as literals; api.test.ts compares every entry with ROUTES so a
 * drift in the contract fails a test instead of a demo.
 */
import type { ErrorCode } from '@/contracts/errors';
import type { RouteRequest, RouteResponse } from '@/contracts/api';

export const PATHS = {
  authChallenge: '/api/auth/challenge',
  authVerify: '/api/auth/verify',
  authLogout: '/api/auth/logout',
  me: '/api/me',
  meActivity: '/api/me/activity',
  meProfile: '/api/me/profile',
  paddleRelease: '/api/shows/:id/paddle',
  showsList: '/api/shows',
  showsCreate: '/api/shows',
  showsGet: '/api/shows/:id',
  showGoLive: '/api/shows/:id/go-live',
  showEnd: '/api/shows/:id/end',
  showCancel: '/api/shows/:id/cancel',
  showPause: '/api/shows/:id/pause',
  showResume: '/api/shows/:id/resume',
  auctionLive: '/api/auctions/:id/live',
  lotPatch: '/api/lots/:id',
  lotControl: '/api/lots/:id/control',
  sellAssets: '/api/sell/assets',
  lotReadiness: '/api/lots/:id/readiness',
  settlementGet: '/api/settlements/:id',
  devnetFaucet: '/api/devnet/faucet',
  devnetMintCard: '/api/devnet/mint-card',
} as const;
export type PathKey = keyof typeof PATHS;

export type ApiOk<T> = { ok: true; data: T };
export type ApiFail = {
  ok: false;
  status: number;
  /** `network`: the request never got an answer. `unknown`: an error body we do not recognise. */
  code: ErrorCode | 'network' | 'unknown';
  reason: string;
  retryAfterS?: number;
  /** A refused profile field (`validation` from PATCH /api/me/profile): which field and which rule. */
  field?: string;
  rule?: string;
};
export type ApiResult<T> = ApiOk<T> | ApiFail;

const fill = (template: string, id?: string) => (id ? template.replace(':id', encodeURIComponent(id)) : template);

/** One place that talks to fetch. Never throws (except an aborted request, which the caller asked for). */
export async function call<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Record<string, string | undefined>; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  const q = Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined) as [string, string][];
  const url = q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return { ok: false, status: 0, code: 'network', reason: e instanceof Error ? e.message : 'network error' };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok) return { ok: true, data: json as T };
  const b = (json && typeof json === 'object' ? json : {}) as { code?: string; reason?: string; retryAfterS?: number; field?: string; rule?: string };
  const header = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10);
  const retryAfterS = typeof b.retryAfterS === 'number' ? b.retryAfterS : Number.isFinite(header) ? header : undefined;
  const code = (b.code ?? (res.status === 404 ? 'not_found' : res.status === 401 ? 'unauthenticated' : 'unknown')) as ApiFail['code'];
  return { ok: false, status: res.status, code, reason: b.reason ?? res.statusText ?? '', retryAfterS, ...(typeof b.field === 'string' ? { field: b.field } : {}), ...(typeof b.rule === 'string' ? { rule: b.rule } : {}) };
}

// ---- identity -------------------------------------------------------------------------------

/** `data` is undefined when there is no session (the route answers 204). */
export const getMe = (show?: string) => call<RouteResponse<'me'> | undefined>('GET', PATHS.me, { query: { show } });
export const logout = () => call<void>('POST', PATHS.authLogout);
export const authChallenge = (wallet: string) =>
  call<RouteResponse<'authChallenge'>>('POST', PATHS.authChallenge, { body: { wallet } satisfies RouteRequest<'authChallenge'> });
export const authVerify = (body: RouteRequest<'authVerify'>) => call<RouteResponse<'authVerify'>>('POST', PATHS.authVerify, { body });

// ---- selling --------------------------------------------------------------------------------

export const getSellAssets = () => call<RouteResponse<'sellAssets'>>('GET', PATHS.sellAssets);
export const mintTestCard = () => call<RouteResponse<'devnetMintCard'>>('POST', PATHS.devnetMintCard, { body: {} });
export const createShow = (body: RouteRequest<'showsCreate'>) => call<RouteResponse<'showsCreate'>>('POST', PATHS.showsCreate, { body });
export const checkLotReadiness = (lotId: string) =>
  call<RouteResponse<'lotReadiness'>>('POST', fill(PATHS.lotReadiness, lotId), { body: {} });

// ---- managing a show ------------------------------------------------------------------------

export const getShow = (id: string) => call<RouteResponse<'showsGet'>>('GET', fill(PATHS.showsGet, id));
export const getSnapshot = (id: string, signal?: AbortSignal) => call<RouteResponse<'auctionLive'>>('GET', fill(PATHS.auctionLive, id), { signal });
export const goLive = (id: string) => call<RouteResponse<'showGoLive'>>('POST', fill(PATHS.showGoLive, id), { body: {} });
export const endShow = (id: string) => call<RouteResponse<'showEnd'>>('POST', fill(PATHS.showEnd, id), { body: {} });
export const cancelShow = (id: string) => call<RouteResponse<'showCancel'>>('POST', fill(PATHS.showCancel, id), { body: {} });
export const pauseShow = (id: string) => call<RouteResponse<'showPause'>>('POST', fill(PATHS.showPause, id), { body: {} });
export const resumeShow = (id: string) => call<RouteResponse<'showResume'>>('POST', fill(PATHS.showResume, id), { body: {} });
export const patchLot = (lotId: string, body: RouteRequest<'lotPatch'>) => call<RouteResponse<'lotPatch'>>('PATCH', fill(PATHS.lotPatch, lotId), { body });
export const controlLot = (lotId: string, body: RouteRequest<'lotControl'>) => call<RouteResponse<'lotControl'>>('POST', fill(PATHS.lotControl, lotId), { body });

// ---- the schedule ---------------------------------------------------------------------------

/** Validated against the contract: an answer in any other shape is an error state, never a render-time crash. */
export async function listShows(status?: 'scheduled' | 'live' | 'ended', limit = 20, house?: 'only' | 'exclude'): Promise<ApiResult<RouteResponse<'showsList'>>> {
  // The schema (zod and the contracts, about 80 kB of script) is fetched beside the request, not with the page: the schedule needs it only once the answer is in.
  const [r, { ShowListResponse }] = await Promise.all([
    call<unknown>('GET', PATHS.showsList, { query: { status, ...(house ? { house } : {}), limit: String(limit) } }),
    import('@/contracts/api'),
  ]);
  if (!r.ok) return r;
  const parsed = ShowListResponse.safeParse(r.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 200, code: 'unknown', reason: 'The schedule answered in an unexpected format' };
}
