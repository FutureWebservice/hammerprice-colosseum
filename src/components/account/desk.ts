/** Pure helpers for the settlement desk on /account. */
import type { MeResponse, ShowSummary } from '@/contracts/api';

/** One row of /api/me `pending`. `showId` is in the contract now; the lot audit page stays as a fallback for older rows. */
export type PendingSettlement = MeResponse['pending'][number] & { showId?: string };

/**
 * Where the signing UI for a settlement lives. ROOM owns it inside the room (PayModal and SettlementReview),
 * which is addressed by show id. Without a show id the public audit page for the lot is the closest real page.
 */
export function settlementHref(p: PendingSettlement): string {
  return p.showId ? `/room/${p.showId}?settle=${p.settlementId}` : `/verify/${p.lotId}`;
}

/** Soonest deadline first: that is the one that can still be lost. */
export const sortByDue = (list: PendingSettlement[]): PendingSettlement[] =>
  [...list].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

/** The seller must co-sign delivery; a seller who lets the window pass gets a strike. */
export const hasSellerRole = (list: PendingSettlement[]) => list.some((p) => p.role === 'seller');

/** Shows where a paddle could exist: not over yet. The account page asks /api/me?show= for each (bounded). */
export const paddleCandidates = (shows: ShowSummary[], max = 8): ShowSummary[] => shows.filter((s) => s.status !== 'ended').slice(0, max);
