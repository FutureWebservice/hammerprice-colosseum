/**
 * Browser storage that never throws. localStorage and sessionStorage can be missing or throw (private window,
 * blocked site data, previews), and every UX helper (tour seen, hint seen, advanced open) must then just forget.
 * The store is a parameter so tests can hand in a fake or a throwing one.
 */
export type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function browserStore(kind: 'local' | 'session'): Store | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readFlag(store: Store | null, key: string): string | null {
  try { return store ? store.getItem(key) : null; } catch { return null; }
}

/** True when the value was stored. */
export function writeFlag(store: Store | null, key: string, value: string): boolean {
  try { if (!store) return false; store.setItem(key, value); return true; } catch { return false; }
}
