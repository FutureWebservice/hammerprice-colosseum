import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The codebase imports everywhere via the `@/*` -> `src/*` alias declared in tsconfig.json.
// Vitest doesn't read tsconfig `paths` on its own, so any test whose import chain crossed
// into a file using `@/...` failed to resolve - it just hadn't happened yet before this.
export default defineConfig({
  // The route tests give each caller its own address in x-forwarded-for; clientIp only trusts that header on Vercel (see lib/http/ratelimit.ts).
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    env: { VERCEL: '1', LIVE_SNAPSHOT_MEMO_MS: '0', HOUSEKEEPING_INTERVAL_S: '0' }, // no remembering across test requests (lib/http/memo.ts)
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
