import { ApiError } from '@/contracts/errors';
import { fail, json } from '@/lib/http/respond';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { addToWaitlist, isHoneypot, WaitlistBody, WaitlistEmail, WaitlistLocale } from '@/server/admin/waitlist';

/**
 * Join the waiting list: { email, locale, website } -> { ok: true }. `website` is the honeypot (must be empty). The same address again is a no-op.
 * Errors are the usual body plus `error` (the reason), with 400 (validation) or 429 (rate limit).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readBody(req, WaitlistBody);
    // Fails closed: when the counter cannot be written the request fails, it is not waved through. A honeypot hit costs the caller a try like any other.
    assertRate(await rateLimitIp('waitlist', req, 8, 3600));
    if (isHoneypot(body.website)) return json({ ok: true }); // look like success, store nothing
    const email = WaitlistEmail.safeParse(body.email);
    const locale = WaitlistLocale.safeParse(body.locale.toLowerCase());
    if (!email.success) throw new ApiError('validation', 'email: enter a valid email address');
    if (!locale.success) throw new ApiError('validation', 'locale: must be de or en');
    await addToWaitlist(email.data, locale.data);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) return fail(e.code, e.message, { ...e.extra, error: e.message });
    throw e;
  }
}
