import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@/contracts';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** `Authorization: Bearer $CRON_SECRET`, compared in constant time (both sides hashed so the lengths match). No secret configured means nobody is let in. */
export function assertCron(req: Request, env: Record<string, string | undefined> = process.env): void {
  const secret = env.CRON_SECRET;
  const given = req.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) throw new ApiError('unauthenticated', 'Not authorised');
}
