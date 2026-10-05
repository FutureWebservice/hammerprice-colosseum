/**
 * The waiting list (migration 0009, privacy text 3.13): POST /api/waitlist stores one row per address (unique on lower(email)).
 * The address is never logged and never written to audit_logs.
 */
import { z } from 'zod';

/** Loose on purpose: the honeypot answer must not depend on whether the rest of the body is valid. */
export const WaitlistBody = z.object({ email: z.string().max(320), locale: z.string().max(16), website: z.unknown().optional() });

export const WaitlistEmail = z.string().trim().toLowerCase().max(254).email();
export const WaitlistLocale = z.enum(['de', 'en']);

/** True when the hidden field was filled in: only a program does that. */
export const isHoneypot = (website: unknown): boolean => website !== undefined && website !== null && website !== '';

/** Stores the address once. The same address again (any case) changes nothing. Returns whether a row was added. */
export async function addToWaitlist(email: string, locale: 'de' | 'en', source = 'landing'): Promise<boolean> {
  const { db, schema } = await import('@/db');
  const rows = await db.insert(schema.waitlist).values({ email, locale, source }).onConflictDoNothing().returning({ id: schema.waitlist.id });
  return rows.length > 0;
}
