/**
 * AUTH's public face: the AuthApi of contracts/services.ts, plus the pieces callers build on.
 * Server-only modules (session, login, store) are NOT re-exported for the browser; client code imports
 * `@/lib/auth/intent` (pure) and `@/lib/client/session`.
 */
import type { AuthApi } from '@/contracts';
import { rateLimit } from '@/lib/http/ratelimit';
import { parseBidIntent, verifyBidIntent, verifyPaddleAuth } from './intent';
import { getSession, requireSession } from './session';

export const auth = { getSession, requireSession, parseBidIntent, verifyBidIntent, verifyPaddleAuth, rateLimit } satisfies AuthApi;

export { getSession, requireSession, requireSessionProfile } from './session';
export * from './intent';
