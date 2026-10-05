/**
 * The calls the server makes to the media server (MediaMTX), and nothing else: the live check (`isStreamLive`), `kick` and the WHIP
 * signaling hop.
 *
 * The Basic credential for publishing is built in `whipOffer` and `whipStop` and nowhere else, and no function here returns, logs or throws
 * upstream text: every failure is a small tagged result the caller turns into `video_unavailable`. Every call has a timeout and never follows
 * a redirect. Only paths under the configured prefix are ever addressed.
 */
import { apiPathUrl, hlsUrl, whipSessionUrl, whipUrl, type VideoConfig } from './paths';

export type Fetch = typeof fetch;

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (s: string): boolean => SESSION_RE.test(s);

const basic = (cfg: VideoConfig): string => `Basic ${Buffer.from(`${cfg.publishUser}:${cfg.publishPass}`).toString('base64')}`;
const apiHeaders = (cfg: VideoConfig): Record<string, string> => (cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {});
const call = (f: Fetch, url: string, init: RequestInit, ms: number): Promise<Response> => f(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ms), cache: 'no-store' });

/**
 * Is somebody sending on this path? The control API first (a 404 there is a definite "no"); the public manifest when the API is not
 * configured or does not answer (a 200 means sending, a 404 means nobody is). Anything else is "no".
 */
export async function isLive(cfg: VideoConfig, path: string, f: Fetch = fetch): Promise<boolean> {
  const api = apiPathUrl(cfg, 'get', path);
  if (api) {
    try {
      const r = await call(f, api, { headers: apiHeaders(cfg) }, 3000);
      if (r.status === 404) return false;
      if (r.ok) {
        const d = (await r.json()) as { ready?: unknown; source?: unknown };
        return d.ready === true || (d.source !== null && d.source !== undefined);
      }
    } catch { /* the API is down or slow: fall back to the manifest */ }
  }
  try {
    const r = await call(f, hlsUrl(cfg, path), {}, 3000);
    return r.status === 200;
  } catch {
    return false;
  }
}

/** Disconnects whoever is publishing on this path (the show ended). Best effort; false when it could not be done. */
export async function kick(cfg: VideoConfig, path: string, f: Fetch = fetch): Promise<boolean> {
  const api = apiPathUrl(cfg, 'kick', path);
  if (!api) return false;
  try {
    return (await call(f, api, { method: 'POST', headers: apiHeaders(cfg) }, 3000)).ok;
  } catch {
    return false;
  }
}

export type WhipResult = { ok: true; answer: string; sessionId: string } | { ok: false };

/** Forwards the sender's SDP offer. Only a 201 with an SDP answer and a session id in `Location` counts; everything else is a plain failure. */
export async function whipOffer(cfg: VideoConfig, path: string, offer: string, f: Fetch = fetch): Promise<WhipResult> {
  try {
    const r = await call(f, whipUrl(cfg, path), { method: 'POST', headers: { 'Content-Type': 'application/sdp', Authorization: basic(cfg) }, body: offer }, 8000);
    if (r.status !== 201) return { ok: false };
    const sessionId = (r.headers.get('location') ?? '').split('?')[0]!.split('/').filter(Boolean).at(-1) ?? '';
    const answer = await r.text();
    if (!isSessionId(sessionId) || !answer.startsWith('v=0') || answer.length > 40_000) return { ok: false };
    return { ok: true, answer, sessionId: sessionId.toLowerCase() };
  } catch {
    return { ok: false };
  }
}

/** Ends one WHIP session. The upstream address is rebuilt from the configuration and a session id that matched the UUID pattern. */
export async function whipStop(cfg: VideoConfig, path: string, sessionId: string, f: Fetch = fetch): Promise<boolean> {
  if (!isSessionId(sessionId)) return false;
  try {
    const r = await call(f, whipSessionUrl(cfg, path, sessionId.toLowerCase()), { method: 'DELETE', headers: { Authorization: basic(cfg) } }, 8000);
    return r.ok || r.status === 404; // 404: the session is already gone
  } catch {
    return false;
  }
}
