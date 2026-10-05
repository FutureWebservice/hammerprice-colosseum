import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CONFIG = require.resolve('../../../next.config.js');

/** Loads next.config.js fresh with the given env and returns the headers it would send on a page. */
async function headersFor(env: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[CONFIG];
  try {
    const cfg = require(CONFIG);
    const rules = await cfg.headers();
    const page = rules.find((r: { source: string }) => r.source === '/:path*');
    return { map: Object.fromEntries(page.headers.map((h: { key: string; value: string }) => [h.key, h.value])) as Record<string, string>, rules, cfg };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete require.cache[CONFIG];
  }
}

afterEach(() => { delete require.cache[CONFIG]; });

describe('security headers', () => {
  it('drops every inherited third party and allows only what the app uses', async () => {
    const { map } = await headersFor({ NEXT_PUBLIC_SOLANA_RPC_PUBLIC: undefined, NEXT_PUBLIC_MEDIA_SERVER_URL: undefined });
    const csp = map['Content-Security-Policy'];
    for (const gone of ['supabase', 'livepeer', 'bonkstream', 'tradingview', 'googleapis', 'gstatic', 'coingecko']) expect(csp, gone).not.toContain(gone);
    for (const need of ['wss://api.devnet.solana.com', 'https://api.mainnet-beta.solana.com', 'https://api.collectorcrypt.com', 'https://*.cloudfront.net']) expect(csp, need).toContain(need);
    for (const d of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'", "font-src 'self'", "default-src 'self'"]) expect(csp, d).toContain(d);
    expect(csp).not.toContain('https:;');
    expect(map['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(map['X-Content-Type-Options']).toBe('nosniff');
    expect(map['Strict-Transport-Security']).toContain('max-age=63072000');
  });

  it('adds a clean configured RPC host and ignores the polluted production value', async () => {
    const good = await headersFor({ NEXT_PUBLIC_SOLANA_RPC_PUBLIC: 'https://rpc.example-node.test' });
    expect(good.map['Content-Security-Policy']).toContain('wss://rpc.example-node.test');
    const polluted = await headersFor({ NEXT_PUBLIC_SOLANA_RPC_PUBLIC: 'https://evil.example      # Client-safe (no key)' });
    expect(polluted.map['Content-Security-Policy']).not.toContain('evil.example');
  });

  it('allows a media host only when one is configured', async () => {
    expect((await headersFor({ NEXT_PUBLIC_MEDIA_SERVER_URL: undefined })).map['Content-Security-Policy']).toContain("media-src 'self' blob:;");
    expect((await headersFor({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'stream.example.test:8888' })).map['Content-Security-Policy']).toContain('media-src \'self\' blob: https://stream.example.test:8888;');
  });

  it('sets no blanket Cache-Control on /api and no standalone output', async () => {
    const { rules, cfg } = await headersFor({});
    expect(rules.every((r: { source: string }) => !r.source.startsWith('/api'))).toBe(true);
    expect(cfg.output).toBeUndefined();
  });
});

describe('the optional live video (headers, CSP port, public switch)', () => {
  const csp = async (env: Record<string, string | undefined>) => (await headersFor({ NEXT_PUBLIC_MEDIA_SERVER_HLS_PORT: undefined, VIDEO_ALLOW_INSECURE_TARGET: undefined, VERCEL_ENV: undefined, ...env })).map['Content-Security-Policy'];

  it('a bare media host gets the HLS port (8888 by default), so the existing value can stay as it is: a source without a port only covers 443', async () => {
    const c = await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'stream.example.test' });
    expect(c).toContain("media-src 'self' blob: https://stream.example.test:8888;");
    expect(c).toContain('https://stream.example.test:8888');
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'stream.example.test', NEXT_PUBLIC_MEDIA_SERVER_HLS_PORT: '9000' })).toContain('https://stream.example.test:9000;');
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'stream.example.test', NEXT_PUBLIC_MEDIA_SERVER_HLS_PORT: 'x; script-src *' })).toContain('https://stream.example.test:8888;');
  });

  it('a host with its own port is used as written, and a malformed host adds nothing', async () => {
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'stream.example.test:7777' })).toContain('https://stream.example.test:7777');
    const bad = await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'a.test; script-src *' });
    expect(bad).not.toContain('a.test');
  });

  it('plain http to a loopback fake is allowed only with the test switch, and never in production', async () => {
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: '127.0.0.1:4010' })).toContain('media-src \'self\' blob: https://127.0.0.1:4010;');
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: '127.0.0.1:4010', VIDEO_ALLOW_INSECURE_TARGET: 'true' })).toContain('media-src \'self\' blob: http://127.0.0.1:4010;');
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: '127.0.0.1:4010', VIDEO_ALLOW_INSECURE_TARGET: 'true', VERCEL_ENV: 'production' })).toContain('https://127.0.0.1:4010;');
    expect(await csp({ NEXT_PUBLIC_MEDIA_SERVER_URL: 'stream.example.test', VIDEO_ALLOW_INSECURE_TARGET: 'true' })).toContain('https://stream.example.test:8888;');
  });

  it('only the broadcast page may use the camera and microphone, and its rule comes AFTER the global one (the last matching rule wins)', async () => {
    const { rules, map } = await headersFor({});
    expect(map['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
    const policy = (r: { headers: { key: string }[] }) => r.headers.some((h) => h.key === 'Permissions-Policy');
    const withPolicy = rules.filter(policy);
    expect(withPolicy).toHaveLength(2);
    expect(withPolicy[0].source).toBe('/:path*');
    expect(withPolicy[1].source).toBe('/:locale/sell/:showId/broadcast');
    expect(rules.indexOf(withPolicy[1])).toBeGreaterThan(rules.indexOf(withPolicy[0]));
    expect(withPolicy[1].headers.find((h: { key: string }) => h.key === 'Permissions-Policy').value).toBe('camera=(self), microphone=(self), geolocation=()');
    // the exception is for that one page: it must not widen anything else
    expect(withPolicy[1].headers).toHaveLength(1);
  });

  it('the browser learns only whether to show the video controls: NEXT_PUBLIC_FEATURE_VIDEO follows FEATURE_VIDEO when it is exactly true', async () => {
    const none = { SOLANA_CLUSTER: undefined, NEXT_PUBLIC_SOLANA_NETWORK: undefined, PLATFORM_WALLET_ADDRESS: undefined, NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: undefined };
    expect((await headersFor({ ...none, FEATURE_VIDEO: 'true', NEXT_PUBLIC_FEATURE_VIDEO: undefined })).cfg.env).toEqual({ NEXT_PUBLIC_FEATURE_VIDEO: 'true' });
    expect((await headersFor({ ...none, FEATURE_VIDEO: 'yes', NEXT_PUBLIC_FEATURE_VIDEO: undefined })).cfg.env).toEqual({});
    expect((await headersFor({ ...none, FEATURE_VIDEO: undefined, NEXT_PUBLIC_FEATURE_VIDEO: undefined })).cfg.env).toEqual({});
  });

  it('the navigation shows the packs link only when FEATURE_PACKS is exactly true: NEXT_PUBLIC_FEATURE_PACKS follows it', async () => {
    const none = { SOLANA_CLUSTER: undefined, NEXT_PUBLIC_SOLANA_NETWORK: undefined, PLATFORM_WALLET_ADDRESS: undefined, NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: undefined, FEATURE_VIDEO: undefined, NEXT_PUBLIC_FEATURE_VIDEO: undefined };
    expect((await headersFor({ ...none, FEATURE_PACKS: 'true', NEXT_PUBLIC_FEATURE_PACKS: undefined })).cfg.env).toEqual({ NEXT_PUBLIC_FEATURE_PACKS: 'true' });
    expect((await headersFor({ ...none, FEATURE_PACKS: 'on', NEXT_PUBLIC_FEATURE_PACKS: undefined })).cfg.env).toEqual({});
    expect((await headersFor({ ...none, FEATURE_PACKS: undefined, NEXT_PUBLIC_FEATURE_PACKS: undefined })).cfg.env).toEqual({});
  });

  it('the verify page asks for a lot-order proof only when FEATURE_VRF is exactly true: NEXT_PUBLIC_FEATURE_VRF follows it', async () => {
    const none = { SOLANA_CLUSTER: undefined, NEXT_PUBLIC_SOLANA_NETWORK: undefined, PLATFORM_WALLET_ADDRESS: undefined, NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: undefined, FEATURE_VIDEO: undefined, NEXT_PUBLIC_FEATURE_VIDEO: undefined, FEATURE_PACKS: undefined, NEXT_PUBLIC_FEATURE_PACKS: undefined };
    expect((await headersFor({ ...none, FEATURE_VRF: 'true', NEXT_PUBLIC_FEATURE_VRF: undefined })).cfg.env).toEqual({ NEXT_PUBLIC_FEATURE_VRF: 'true' });
    expect((await headersFor({ ...none, FEATURE_VRF: 'on', NEXT_PUBLIC_FEATURE_VRF: undefined })).cfg.env).toEqual({});
    expect((await headersFor({ ...none, FEATURE_VRF: undefined, NEXT_PUBLIC_FEATURE_VRF: undefined })).cfg.env).toEqual({});
  });
});

describe('one switch: the browser bundle follows SOLANA_CLUSTER', () => {
  it('derives the public network and fee wallet from the server variables when the public ones are unset', async () => {
    const { cfg } = await headersFor({ SOLANA_CLUSTER: 'mainnet-beta', NEXT_PUBLIC_SOLANA_NETWORK: undefined, PLATFORM_WALLET_ADDRESS: 'FeeWa11etAddressForThisTestOnly1111111111111', NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: undefined });
    expect(cfg.env).toEqual({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta', NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: 'FeeWa11etAddressForThisTestOnly1111111111111' });
  });
  it('never overrides a public value that is set (a disagreement is reported by /api/health, not hidden)', async () => {
    const { cfg } = await headersFor({ SOLANA_CLUSTER: 'mainnet-beta', NEXT_PUBLIC_SOLANA_NETWORK: 'devnet', PLATFORM_WALLET_ADDRESS: undefined, NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: undefined });
    expect(cfg.env).toEqual({});
  });
  it('adds nothing when no cluster is configured (devnet default)', async () => {
    const { cfg } = await headersFor({ SOLANA_CLUSTER: undefined, NEXT_PUBLIC_SOLANA_NETWORK: undefined, PLATFORM_WALLET_ADDRESS: undefined, NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: undefined });
    expect(cfg.env).toEqual({});
  });
});

describe('cache headers for files from public/', () => {
  it('the hero frames, the screenshots and the icons are kept a day (and served stale for a week while one is fetched); the API is left to its routes', async () => {
    const { rules } = await headersFor({});
    const cache = (source: string) => rules.find((r: { source: string }) => r.source === source)?.headers.find((h: { key: string }) => h.key === 'Cache-Control')?.value;
    for (const src of ['/generated/:path*', '/pitch/:path*', '/icons/:path*']) expect(cache(src), src).toBe('public, max-age=86400, stale-while-revalidate=604800');
    expect(rules.some((r: { source: string }) => r.source.startsWith('/api'))).toBe(false);
  });
});
