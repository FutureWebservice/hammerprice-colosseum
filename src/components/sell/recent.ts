/**
 * The shows this browser created, so the seller can find the manage page again. The API has no "my shows"
 * list, so this is a per-browser convenience kept in localStorage (never the source of truth: the manage page
 * asks the server, which checks that the caller is the seller).
 */
import { isValidUuid } from '@/lib/uuid';

const KEY = 'hp.sell.recent';
const MAX = 10;
export interface RecentShow { id: string; title: string; at: number }
type Store = Pick<Storage, 'getItem' | 'setItem'>;

const browserStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (private window, site data off)
  }
};

export function readRecent(store: Store | null = browserStore()): RecentShow[] {
  try {
    const raw = store?.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is RecentShow => !!x && typeof x.id === 'string' && isValidUuid(x.id) && typeof x.title === 'string' && typeof x.at === 'number')
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function rememberShow(show: { id: string; title: string }, now = Date.now(), store: Store | null = browserStore()): void {
  try {
    const next = [{ ...show, at: now }, ...readRecent(store).filter((r) => r.id !== show.id)].slice(0, MAX);
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the list is a convenience */
  }
}
