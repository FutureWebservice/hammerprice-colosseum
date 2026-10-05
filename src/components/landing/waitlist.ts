/**
 * The call behind the landing page's waiting-list form, as a pure function over an injectable `fetch` so a test can mock it
 * (no DOM library is installed). POST /api/waitlist with {email, locale, website}; the endpoint answers {ok:true} (200) or {error}
 * (400 invalid, 429 too many). The server's own words are never shown: the status picks the localized message.
 */
import type { Locale } from '@/lib/i18n/config';

export interface WaitlistLabels {
  label: string;
  placeholder: string;
  submit: string;
  sending: string;
  success: string;
  errorInvalid: string;
  errorTooMany: string;
  errorGeneric: string;
  privacyBefore: string;
  privacyLink: string;
}

export type WaitlistResult = { ok: true } | { ok: false; message: string };

export async function submitWaitlist(
  input: { email: string; locale: Locale; website: string },
  labels: Pick<WaitlistLabels, 'errorInvalid' | 'errorTooMany' | 'errorGeneric'>,
  doFetch: typeof fetch = fetch,
): Promise<WaitlistResult> {
  try {
    const res = await doFetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: input.email.trim(), locale: input.locale, website: input.website }),
    });
    const body: { ok?: boolean } | null = await res.json().catch(() => null);
    if (res.ok && body?.ok === true) return { ok: true };
    return { ok: false, message: res.status === 400 ? labels.errorInvalid : res.status === 429 ? labels.errorTooMany : labels.errorGeneric };
  } catch {
    return { ok: false, message: labels.errorGeneric };
  }
}
