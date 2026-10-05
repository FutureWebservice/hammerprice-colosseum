/** @type {import('next').NextConfig} */
const createNextIntlPlugin = require('next-intl/plugin');

// Specify the exact path to the request config
const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

const isProd = process.env.NODE_ENV === 'production';

// `https://host` and `wss://host` for an env value that must be one clean URL. A value with stray
// whitespace or a trailing comment (a real production variable once held
// "https://mainnet.helius-rpc.com      # Client-safe (no key)") is ignored instead of widening the CSP.
function hostSources(value) {
  if (!value || /\s/.test(value)) return [];
  try {
    const { host, protocol } = new URL(value);
    return protocol === 'https:' ? [`https://${host}`, `wss://${host}`] : [];
  } catch {
    return [];
  }
}

// What the browser may talk to besides this origin: public Solana RPC (devnet and mainnet, HTTP and
// WebSocket), the optional dedicated RPC the app is configured with, and the vault API. Card photos
// come from the vault's CloudFront distribution. Nothing else: no analytics, no fonts CDN, no video host
// unless NEXT_PUBLIC_MEDIA_SERVER_URL is set.
const rpcHosts = [
  'api.devnet.solana.com', 'api.mainnet-beta.solana.com', 'api.testnet.solana.com',
  '*.helius-rpc.com',
].flatMap((h) => [`https://${h}`, `wss://${h}`]);
const vaultApi = ['https://api.collectorcrypt.com', 'https://dev-api.collectorcrypt.com'];
const configuredRpc = hostSources(process.env.NEXT_PUBLIC_SOLANA_RPC_PUBLIC);
// The video host serves HLS on its own port. A source without a port only covers 443, so when NEXT_PUBLIC_MEDIA_SERVER_URL is a bare host
// the HLS port (NEXT_PUBLIC_MEDIA_SERVER_HLS_PORT, default 8888) is appended and the existing value can stay as it is. A loopback host over
// plain http is allowed only for the video tests (VIDEO_ALLOW_INSECURE_TARGET, never on a production deployment; same rule as server/streams/paths.ts).
const mediaHost = process.env.NEXT_PUBLIC_MEDIA_SERVER_URL?.trim();
const mediaHlsPort = /^\d{1,5}$/.test(process.env.NEXT_PUBLIC_MEDIA_SERVER_HLS_PORT ?? '') ? process.env.NEXT_PUBLIC_MEDIA_SERVER_HLS_PORT : '8888';
const mediaInsecure = process.env.VIDEO_ALLOW_INSECURE_TARGET === 'true' && process.env.VERCEL_ENV !== 'production' && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(mediaHost ?? '');
const media = mediaHost && /^[a-z0-9.-]+(:\d+)?$/i.test(mediaHost) ? [`${mediaInsecure ? 'http' : 'https'}://${/:\d+$/.test(mediaHost) ? mediaHost : `${mediaHost}:${mediaHlsPort}`}`] : [];

const csp = [
  "default-src 'self'",
  // 'unsafe-inline' stays for Next's bootstrap scripts (nonces are a later hardening); dev needs eval.
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https://*.cloudfront.net",
  `connect-src ${["'self'", ...rpcHosts, ...configuredRpc, ...vaultApi, ...media].join(' ')}`,
  `media-src ${["'self'", 'blob:', ...media].join(' ')}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// ONE switch: SOLANA_CLUSTER (server) decides the network, and the browser bundle follows it. NEXT_PUBLIC_SOLANA_NETWORK is inlined at
// build time, so when it is not set it is taken from SOLANA_CLUSTER here; when both are set and disagree, /api/health reports
// cluster_config_conflict and the money routes refuse (src/lib/chain/cluster.ts). The fee wallet's public address follows the same rule.
const derivedPublicEnv = {};
if (!process.env.NEXT_PUBLIC_SOLANA_NETWORK && process.env.SOLANA_CLUSTER) derivedPublicEnv.NEXT_PUBLIC_SOLANA_NETWORK = process.env.SOLANA_CLUSTER;
if (!process.env.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS && process.env.PLATFORM_WALLET_ADDRESS) derivedPublicEnv.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS = process.env.PLATFORM_WALLET_ADDRESS;

// The optional live video: the browser only needs to know whether to show the controls (the server checks the real switch on every call).
if (!process.env.NEXT_PUBLIC_FEATURE_VIDEO && process.env.FEATURE_VIDEO === 'true') derivedPublicEnv.NEXT_PUBLIC_FEATURE_VIDEO = 'true';
// Packs: the navigation shows its link only when the feature is on. The pages and routes check the real switch on every request.
if (!process.env.NEXT_PUBLIC_FEATURE_PACKS && process.env.FEATURE_PACKS === 'true') derivedPublicEnv.NEXT_PUBLIC_FEATURE_PACKS = 'true';
// Drawn lot order: the verify page asks for a show's proof only when the feature is on (with it off the route answers 404, a console error on every verify page).
if (!process.env.NEXT_PUBLIC_FEATURE_VRF && process.env.FEATURE_VRF === 'true') derivedPublicEnv.NEXT_PUBLIC_FEATURE_VRF = 'true';

const nextConfig = {
  env: derivedPublicEnv,
  reactStrictMode: true,
  poweredByHeader: false,
  // Inline the route's CSS in the HTML instead of 5 to 8 render-blocking stylesheet requests.
  experimental: { inlineCss: true },
  compiler: {
    // Remove console.* in production builds
    removeConsole: isProd ? { exclude: ['error', 'warn'] } : false,
  },
  // Transpile packages for better compatibility
  transpilePackages: ['next-intl'],

  // Old and alternate legal URLs (src/legal/redirects.json, generated from src/legal/routes.ts and checked by a test), and the three
  // pages that became sections of /about (src/lib/old-routes.json, permanent = 308, checked by src/lib/__tests__/old-routes.test.ts).
  async redirects() {
    return [...require('./src/legal/redirects.json'), ...require('./src/lib/old-routes.json')];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      // The broadcast page is the one page that may use the camera and microphone. A later rule wins over an earlier one for the same key,
      // so this must stay AFTER the global rule above (a test pins the order).
      {
        source: '/:locale/sell/:showId/broadcast',
        headers: [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' }],
      },
      // Files from public/ are served with "max-age=0, must-revalidate" unless told otherwise, so every visit asked again for each of the hero's frames and the About
      // page's screenshots. They change only when regenerated: a day without asking, and a week of serving the old file while the new one is fetched.
      ...['/generated/:path*', '/pitch/:path*', '/icons/:path*'].map((source) => ({ source, headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }] })),
      // No blanket Cache-Control for /api: a global header overrides the route's own (measured), so
      // every route sets its cache mode through src/lib/http/respond.ts.
    ];
  },
};

module.exports = withNextIntl(nextConfig);
