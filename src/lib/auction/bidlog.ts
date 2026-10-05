/**
 * The signed bid log of a lot and its hash.
 *
 * preimage = lines joined by "\n", one line per accepted bid, each line `<bids.message>|<bids.signature>`, bids
 * ordered by (placed_at, id). hash = sha-256 of the preimage, lower-case hex. The hash is stored in
 * `settlements.bid_log_hash` and `rail_state`, and sits inside the settlement memo, so the chain anchors the log.
 *
 * Ordering is done here in JS at millisecond precision (what a verifier in the browser can see), ties broken by
 * id, so the server and the public /verify page always agree on the order. A hash needs determinism, not the true
 * sequence; two bids in one millisecond are still ordered the same way everywhere. Every row in `bids` is an
 * accepted bid (rejected bids are never inserted).
 */
import { createHash } from 'node:crypto';

export interface LoggedBid { id: string; message: string; signature: string; placedAt: Date | string | number }

const ms = (t: Date | string | number): number => (t instanceof Date ? t.getTime() : new Date(t).getTime());

/** The exact text that is hashed. The browser can hash this with `crypto.subtle.digest('SHA-256', ...)`. */
export function bidLogPreimage(bids: readonly LoggedBid[]): string {
  return [...bids]
    .sort((a, b) => ms(a.placedAt) - ms(b.placedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((b) => `${b.message}|${b.signature}`)
    .join('\n');
}

/** sha-256 hex of the preimage. An empty log hashes the empty string. */
export function bidLogHash(bids: readonly LoggedBid[]): string {
  return createHash('sha256').update(bidLogPreimage(bids), 'utf8').digest('hex');
}
