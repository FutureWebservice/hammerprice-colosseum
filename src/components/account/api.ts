/** Typed wrappers for the account page. Same conventions as components/sell/api.ts. */
import type { RouteRequest, RouteResponse } from '@/contracts/api';
import { call, PATHS, type ApiFail, type ApiResult } from '@/components/sell/api';

export type ActivityTab = 'bids' | 'wins' | 'consignments';

export const getActivity = (tab: ActivityTab, cursor?: string) =>
  call<RouteResponse<'meActivity'>>('GET', PATHS.meActivity, { query: { tab, cursor } });

export const getSettlement = (id: string) => call<RouteResponse<'settlementGet'>>('GET', PATHS.settlementGet.replace(':id', encodeURIComponent(id)));

export const claimFaucet = () => call<RouteResponse<'devnetFaucet'>>('POST', PATHS.devnetFaucet, { body: {} });

export const releasePaddle = (showId: string) => call<void>('DELETE', PATHS.paddleRelease.replace(':id', encodeURIComponent(showId)));

export const getProfile = () => call<RouteResponse<'meProfile'>>('GET', PATHS.meProfile);
export const saveProfile = (body: RouteRequest<'meProfileUpdate'>) => call<RouteResponse<'meProfileUpdate'>>('PATCH', PATHS.meProfile, { body });

// ---- the profile page ------------------------------------------------------------------------
// Paths are literals (the browser bundle must not import the zod contracts); api.test.ts compares them with ROUTES.
export const PROFILE_PATHS = { meAvatar: '/api/me/avatar', meWallet: '/api/me/wallet', meSummary: '/api/me/summary', meShows: '/api/me/shows', aiCredits: '/api/ai/credits' } as const;
export const avatarSrc = (profileId: string, version: number) => `/api/avatar/${encodeURIComponent(profileId)}?v=${version}`;

export const getWallet = () => call<RouteResponse<'meWallet'>>('GET', PROFILE_PATHS.meWallet);
export const getSummary = () => call<RouteResponse<'meSummary'>>('GET', PROFILE_PATHS.meSummary);
export const getMyShows = (cursor?: string) => call<RouteResponse<'meShows'>>('GET', PROFILE_PATHS.meShows, { query: { limit: '20', cursor } });
/** Fails with `feature_off` (404) while AI is switched off. */
export const getCredits = () => call<RouteResponse<'aiCredits'>>('GET', PROFILE_PATHS.aiCredits);
export const deleteAvatar = () => call<RouteResponse<'meAvatarClear'>>('DELETE', PROFILE_PATHS.meAvatar);

/** The picture goes up as the raw file (call() sends JSON only). The server decides the type from the bytes; the declared type is only a hint. */
export async function uploadAvatar(file: Blob): Promise<ApiResult<RouteResponse<'meAvatarSet'>>> {
  let res: Response;
  try {
    res = await fetch(PROFILE_PATHS.meAvatar, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, cache: 'no-store', credentials: 'same-origin' });
  } catch (e) {
    return { ok: false, status: 0, code: 'network', reason: e instanceof Error ? e.message : 'network error' };
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.ok) return { ok: true, data: json as RouteResponse<'meAvatarSet'> };
  const b = (json && typeof json === 'object' ? json : {}) as { code?: string; reason?: string; retryAfterS?: number; field?: string; rule?: string };
  const header = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10);
  return {
    ok: false, status: res.status, code: (b.code ?? (res.status === 401 ? 'unauthenticated' : 'unknown')) as ApiFail['code'], reason: b.reason ?? res.statusText ?? '',
    retryAfterS: typeof b.retryAfterS === 'number' ? b.retryAfterS : Number.isFinite(header) ? header : undefined,
    ...(typeof b.rule === 'string' ? { rule: b.rule } : {}),
  };
}
