/**
 * Optional live video: where the media server is and which path belongs to which show. Pure (no I/O), so it is testable on its own.
 *
 * Everything here comes from the environment plus a validated path segment, never from a request: a caller cannot choose the host or the
 * path the server talks to (no SSRF). The host and the paths stay on the server; the only thing a viewer ever receives is `hlsUrl`.
 *
 * Paths on the media server: `<VIDEO_PATH_PREFIX>/<segment>`, prefix `hp` by default (never `live`, which belongs to another app that
 * shares the server). A show's segment is 16 random bytes (base64url), created on first use and kept in `show_secrets.ingest_path`; the house
 * show has a fixed segment (`VIDEO_HOUSE_PATH`, default `house`).
 */
import { randomBytes } from 'node:crypto';

type Env = Record<string, string | undefined>;

export type VideoSenders = 'operator' | 'seller';

export interface VideoConfig {
  /** `https` always, `http` only under the test switch with a loopback host. */
  scheme: 'https' | 'http';
  /** Host name without protocol or port. */
  host: string;
  hlsPort: number;
  webrtcPort: number;
  /** MediaMTX control API base (no trailing slash), or null when it is not configured (the manifest is the fallback). */
  apiBase: string | null;
  apiKey: string | null;
  /** Basic credentials for publishing. Server only. */
  publishUser: string;
  publishPass: string;
  prefix: string;
  houseSegment: string;
  senders: VideoSenders;
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX_RE = /^[a-z0-9_-]{1,16}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
export const RANDOM_SEGMENT_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * `VIDEO_ALLOW_INSECURE_TARGET=true` lets a test point the proxy at a loopback fake over plain http. It is ignored on a production deployment
 * and for any host that is not loopback, so it cannot weaken a real deployment. (It is NOT ignored for VERCEL_ENV=preview because the e2e
 * server runs with that value; on a Vercel preview it can only name loopback, where nothing listens, so it stays harmless. Nobody sets it there.)
 */
export const insecureTargetAllowed = (env: Env = process.env): boolean => env.VIDEO_ALLOW_INSECURE_TARGET === 'true' && env.VERCEL_ENV !== 'production';

const port = (v: string | undefined, fallback: number): number | null => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

/** `host` or `host:port` as written in MEDIA_SERVER_URL (a leading protocol and a trailing slash are tolerated). */
function splitHost(raw: string | undefined): { host: string; port: number | null } | null {
  const v = (raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!v) return null;
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m || !HOST_RE.test(m[1]!)) return null;
  return { host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : null };
}

/** The media-server settings, or null when the environment is incomplete or malformed (the feature then simply has no video). */
export function videoConfig(env: Env = process.env): VideoConfig | null {
  const h = splitHost(env.MEDIA_SERVER_URL);
  const user = env.MEDIAMTX_PUBLISH_USER ?? '';
  const pass = env.MEDIAMTX_PUBLISH_PASS ?? '';
  if (!h || !user || !pass) return null;
  const insecure = insecureTargetAllowed(env) && LOOPBACK.has(h.host);
  const hlsPort = port(env.MEDIA_SERVER_HLS_PORT, h.port ?? 8888);
  const webrtcPort = port(env.MEDIA_SERVER_WEBRTC_PORT, 8889);
  const prefix = (env.VIDEO_PATH_PREFIX ?? 'hp').trim() || 'hp';
  const houseSegment = (env.VIDEO_HOUSE_PATH ?? 'house').trim() || 'house';
  if (hlsPort === null || webrtcPort === null || !PREFIX_RE.test(prefix) || prefix === 'live' || !SEGMENT_RE.test(houseSegment)) return null;
  if (!insecure && LOOPBACK.has(h.host)) return null; // a deployment never talks to itself
  let apiBase: string | null = null;
  const rawApi = (env.MEDIA_SERVER_API_URL ?? '').trim().replace(/\/+$/, '');
  if (rawApi) {
    try {
      const u = new URL(rawApi);
      const okScheme = u.protocol === 'https:' || (insecure && u.protocol === 'http:');
      if (okScheme && !u.username && !u.password && !u.search && !u.hash && (u.pathname === '/' || u.pathname === '') && (!insecure || LOOPBACK.has(u.hostname))) apiBase = u.origin;
    } catch { /* an unparseable value means no API: the manifest check is the fallback */ }
  }
  return {
    scheme: insecure ? 'http' : 'https', host: h.host, hlsPort, webrtcPort, apiBase,
    apiKey: apiBase ? (env.MEDIA_SERVER_API_KEY ?? '').trim() || null : null,
    publishUser: user, publishPass: pass, prefix, houseSegment,
    senders: env.VIDEO_SENDERS === 'seller' ? 'seller' : 'operator',
  };
}

/** `<prefix>/<segment>`; null for a segment that is not one plain path piece. */
export function mediaPath(cfg: Pick<VideoConfig, 'prefix'>, segment: string): string | null {
  return SEGMENT_RE.test(segment) ? `${cfg.prefix}/${segment}` : null;
}

export const newIngestSegment = (): string => randomBytes(16).toString('base64url');

export const hlsUrl = (cfg: VideoConfig, path: string): string => `${cfg.scheme}://${cfg.host}:${cfg.hlsPort}/${path}/index.m3u8`;
export const whipUrl = (cfg: VideoConfig, path: string): string => `${cfg.scheme}://${cfg.host}:${cfg.webrtcPort}/${path}/whip`;
export const whipSessionUrl = (cfg: VideoConfig, path: string, sessionId: string): string => `${whipUrl(cfg, path)}/${sessionId}`;
export const apiPathUrl = (cfg: VideoConfig, verb: 'get' | 'kick', path: string): string | null => (cfg.apiBase ? `${cfg.apiBase}/v3/paths/${verb}/${path}` : null);

/** The house show carries the video only when HOUSE_VIDEO_ENABLED says so (the feature itself still has to be on). */
export const houseVideoEnabled = (env: Env = process.env): boolean => env.HOUSE_VIDEO_ENABLED === 'true';

/** Who may send: the operator wallets (always, they run the platform), and the show's seller only when VIDEO_SENDERS=seller. The house show is operator only. */
export function senderAllowed(o: { wallet: string; sellerWallet: string | null; isHouse: boolean; senders: VideoSenders; operators: string[] }): boolean {
  if (o.operators.includes(o.wallet)) return true;
  return !o.isHouse && o.senders === 'seller' && o.sellerWallet !== null && o.sellerWallet === o.wallet;
}
