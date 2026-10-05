/**
 * "The person tapped Sign in and the wallet was asked." On a phone that is where the page goes to the background (the wallet app or its sheet takes over)
 * and may come back reloaded or with the request lost. The intent is kept in sessionStorage so the page can pick the sign-in up again, ONCE, when it is
 * visible again: the tap was the user gesture, nothing is signed that nobody asked for. Pure over a Storage-like object so it is testable without a browser.
 */
export const INTENT_KEY = 'hp.signin';
/** An intent older than this is forgotten (the challenge itself lives 5 minutes). */
export const INTENT_TTL_MS = 3 * 60_000;

export interface SignInIntent { wallet: string; at: number; resumed: boolean }
export type IntentStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** sessionStorage, or null where it is blocked (private mode, a restricted webview). */
export function browserIntentStore(): IntentStore | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

export function writeIntent(store: IntentStore | null, i: SignInIntent): void {
  try { store?.setItem(INTENT_KEY, JSON.stringify(i)); } catch { /* storage full or blocked: the page just cannot resume */ }
}

export function clearIntent(store: IntentStore | null): void {
  try { store?.removeItem(INTENT_KEY); } catch { /* nothing to do */ }
}

export function readIntent(store: IntentStore | null, nowMs: number): SignInIntent | null {
  try {
    const raw = store?.getItem(INTENT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SignInIntent>;
    if (typeof v.wallet !== 'string' || typeof v.at !== 'number' || nowMs - v.at > INTENT_TTL_MS || nowMs < v.at - 60_000) { clearIntent(store); return null; }
    return { wallet: v.wallet, at: v.at, resumed: v.resumed === true };
  } catch {
    return null;
  }
}

/** Failures that say nothing about the person's wishes: the request or the prompt got lost, so the intent survives them. */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(['network', 'timeout', 'not_connected']);

/**
 * What the page does when it is visible again:
 *  - 'none'     no intent for this wallet (or too old).
 *  - 'check'    look at /api/me first (the verify request may have succeeded while the page was frozen); if still anonymous and the intent was not resumed yet, sign again.
 */
export function resumeIntent(store: IntentStore | null, wallet: string | null, nowMs: number): 'none' | 'check' {
  if (!wallet) return 'none';
  const i = readIntent(store, nowMs);
  return i && i.wallet === wallet ? 'check' : 'none';
}
