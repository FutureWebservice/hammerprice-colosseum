/**
 * House bidders, the service half: feeds the pure decision (bots.ts) from a live snapshot and, when a bid is due, places it through
 * the normal engine path (`placeBid`, via 'house') with a real signature from the bot's own key, so the bid log and the
 * public /verify page treat it like any other bid. House bids need no funds and never settle for money; they exist so the house
 * room is never silent. Switched by HOUSE_BOTS_ENABLED=true and the `house_bots` kill switch in app_flags.
 *
 * Cost: when the pure decision says "nothing to do" (the usual poll) this reads nothing from the database. Only when a bid is due
 * does it read the lot's terms once (cached for the lot's life: terms are fixed once a lot has opened), the show's bidders once
 * (cached per show) and, right before bidding, whether a person has bid on the lot.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import nacl from 'tweetnacl';
import type { Keypair } from '@solana/web3.js';
import type { LiveSnapshot } from '@/contracts';
import { configuredCluster } from '@/lib/auth/config';
import { toBase64 } from '@/lib/auth/ed25519';
import { buildBidIntent } from '@/lib/auth/intent';
import { flagOn } from '@/app/api/auctions/_shared/flags';
import { decideBotBid, HOUSE_BOT_COUNT, isHousePaddle, seededRng, type BotLot } from './bots';

type Engine = typeof import('@/server/auction/service');
type Db = typeof import('@/db').db;
type Exec = { execute(q: ReturnType<typeof sql>): Promise<unknown> };
const rowsOf = <T,>(r: unknown): T[] => (r as { rows: T[] }).rows;

/** Enough that no house bid is ever refused for funds; recorded as the bid's `funded_amount`, which for a house bid is not a balance. */
const HOUSE_FUNDS = 10n ** 15n;

export interface BotDeps {
  db: Db;
  auction: Pick<Engine, 'placeBid'>;
  botKeys(): Keypair[] | null;
  enabled(): boolean;
  /** the second source of randomness for the nonce; tests pass a counter */
  nonce(): string;
}

interface LotTerms { openingPrice: bigint; increment: bigint; value: bigint | null; openedAt: number | null }
interface Bidder { profileId: string; wallet: string; paddleId: string; number: number }

const handledWins = new Set<string>();
/** Small bounded caches (past 200 entries the oldest goes): lot terms, a show's house bidders, lots a person has bid on, the last attempt per lot. */
const terms = new Map<string, LotTerms>();
const bidders = new Map<string, Bidder[]>();
const peopleSeen = new Set<string>();
const lastTry = new Map<string, number>();
const remember = <K, V>(m: Map<K, V>, k: K, v: V) => { if (m.size > 200) m.delete(m.keys().next().value as K); m.set(k, v); };
const rememberPerson = (lotId: string) => { if (peopleSeen.size > 200) peopleSeen.delete(peopleSeen.values().next().value as string); peopleSeen.add(lotId); };
/** Tests only. */
export const clearBotCaches = (): void => { terms.clear(); bidders.clear(); peopleSeen.clear(); lastTry.clear(); handledWins.clear(); };

async function loadTerms(db: Db, lotId: string): Promise<LotTerms | null> {
  const hit = terms.get(lotId);
  if (hit) return hit;
  const [r] = rowsOf<{ opening: string; inc: string; value: string | null; openedAt: number | null }>(await (db as unknown as Exec).execute(sql`
    select opening_price::text as opening, increment::text as inc, insured_value::text as value, (extract(epoch from opened_at) * 1000)::float8 as "openedAt"
    from lots where id = ${lotId}`));
  if (!r) return null;
  const t = { openingPrice: BigInt(r.opening), increment: BigInt(r.inc), value: r.value === null ? null : BigInt(r.value), openedAt: r.openedAt === null ? null : Number(r.openedAt) };
  remember(terms, lotId, t);
  return t;
}

async function loadBidders(db: Db, showId: string, keys: Keypair[]): Promise<Bidder[]> {
  const hit = bidders.get(showId);
  if (hit && hit.length === keys.length) return hit;
  const rows = rowsOf<{ profileId: string; wallet: string; paddleId: string; number: number }>(await (db as unknown as Exec).execute(sql`
    select p.id as "profileId", p.wallet_address as wallet, pd.id as "paddleId", pd.number
    from paddles pd join profiles p on p.id = pd.profile_id
    where pd.show_id = ${showId} and p.is_bot and pd.revoked_at is null order by pd.number`));
  const mine = new Set(keys.map((k) => k.publicKey.toBase58()));
  const list = rows.filter((r) => mine.has(r.wallet));
  if (list.length > 0) remember(bidders, showId, list);
  return list;
}

/** Has a person (not a house bidder) bid on this lot? Asked only right before a house bid; the answer for a lot never goes back to "no". */
async function personHasBid(db: Db, lotId: string): Promise<boolean> {
  if (peopleSeen.has(lotId)) return true;
  const rows = rowsOf(await (db as unknown as Exec).execute(sql`select 1 from bids b join profiles p on p.id = b.bidder_id where b.lot_id = ${lotId} and not p.is_bot limit 1`));
  if (rows.length > 0) rememberPerson(lotId);
  return rows.length > 0;
}

/** The snapshot's last bid time for a lot, from the events it carries (null when the window no longer holds one). */
function lastBidAt(snap: LiveSnapshot, lotId: string): number | null {
  for (let i = snap.events.length - 1; i >= 0; i--) {
    const e = snap.events[i];
    if (e.kind === 'bid.placed' && e.payload.lotId === lotId) return Date.parse(e.at);
  }
  return null;
}

/**
 * A lot a house bidder holds at the close is "sold" to it by the engine, with a settlement waiting for a payment that can never come
 * (the house bidder has no funds and the card never leaves the house). Say so now instead of "awaiting payment" for 15 minutes: the
 * settlement lapses at once with the reason `house_bidder`, no strike (a house bidder is never struck), and the card stays in stock.
 * Decided from the snapshot alone; the UPDATE runs once per lot.
 */
async function expireHouseWins(snap: LiveSnapshot, db: Db): Promise<void> {
  for (const lot of snap.lots) {
    if (lot.state !== 'sold' || lot.settlement?.status !== 'awaiting_payment' || !isHousePaddle(lot.highBidder?.paddle) || handledWins.has(lot.id)) continue;
    if (handledWins.size > 200) handledWins.delete(handledWins.values().next().value as string);
    handledWins.add(lot.id);
    const rows = rowsOf<{ id: string }>(await (db as unknown as Exec).execute(sql`
      update settlements st set status = 'expired', failure_code = 'house_bidder', failure_detail = 'won by a house bidder: no sale', round_expires_at = null
      from profiles b
      where st.lot_id = ${lot.id} and b.id = st.buyer_id and b.is_bot and st.status = 'awaiting_payment' returning st.id`));
    if (rows.length === 0) continue;
    await (db as unknown as Exec).execute(sql`
      insert into show_events (show_id, kind, payload)
      values (${snap.show.id}, 'settlement.expired', ${JSON.stringify({ lotId: lot.id, lotNumber: lot.lotNumber, settlementId: rows[0].id })}::jsonb)`);
  }
}

/**
 * One house bid if one is due, else null. Returns the fresh snapshot after the bid (what the engine returns), so the caller can answer
 * with it instead of the one it already had. Never throws: a failing bot must never break the public snapshot.
 */
export async function maybeHouseBid(snap: LiveSnapshot, over: Partial<BotDeps> = {}): Promise<LiveSnapshot | null> {
  const enabled = over.enabled ?? (() => process.env.HOUSE_BOTS_ENABLED === 'true');
  try {
    // A lot a house bidder won earlier is cleaned up whether or not bidding is switched on now.
    if (snap.lots.some((l) => l.state === 'sold' && l.settlement?.status === 'awaiting_payment' && isHousePaddle(l.highBidder?.paddle))) await expireHouseWins(snap, over.db ?? (await import('@/db')).db);
    if (!enabled() || snap.show.status !== 'live' || !snap.current || snap.show.pause?.paused) return null; // a paused room (the seller's pause) takes no bids, house bidders included
    const live = snap.lots.find((l) => l.id === snap.current!.lotId);
    if (!live || live.state !== 'open' || !live.closesAt) return null;
    // Cheap exits first: a person leads, or the lot already has its share of house bids, decided from the snapshot alone.
    if (live.highBidder?.paddle != null && live.highBidder.paddle > HOUSE_BOT_COUNT) return null;
    if (!(await flagOn('house_bots'))) return null;

    const db = over.db ?? (await import('@/db')).db;
    const t = await loadTerms(db, live.id);
    if (!t) return null;
    const lot: BotLot = {
      state: 'open', closesAt: Date.parse(live.closesAt), openedAt: t.openedAt, highBid: live.highBid === null ? null : BigInt(live.highBid),
      highBidderPaddle: live.highBidder?.paddle ?? null, bidCount: live.bidCount, openingPrice: t.openingPrice, increment: t.increment, value: t.value,
    };
    const decision = decideBotBid({ enabled: true, isHouseShow: snap.show.isHouse, timed: snap.show.kind === 'timed', showLive: true, now: snap.serverNow, lot, lastBidAt: lastBidAt(snap, live.id), rng: seededRng(`${live.id}:${live.bidCount}`) });
    if ('skip' in decision) return null;

    // One try per second per lot per instance: concurrent polls decide the same thing, one is enough.
    if (snap.serverNow - (lastTry.get(live.id) ?? 0) < 1000) return null;
    remember(lastTry, live.id, snap.serverNow);

    const keys = (over.botKeys ?? (await defaultKeys()))();
    if (!keys) return null;
    if (await personHasBid(db, live.id)) return null;
    const bidder = (await loadBidders(db, snap.show.id, keys)).find((b) => b.number === decision.bid.paddle);
    const key = bidder && keys.find((k) => k.publicKey.toBase58() === bidder.wallet);
    if (!bidder || !key) return null;

    const nonce = (over.nonce ?? (() => randomBytes(8).toString('hex')))();
    const message = buildBidIntent({ cluster: configuredCluster(), show: snap.show.id, lot: live.id, amount: decision.bid.amount.toString(), bidder: bidder.wallet, paddle: bidder.paddleId, nonce, issued: snap.serverNow });
    const signature = toBase64(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey));
    const engine = over.auction ?? (await import('@/server/auction/service'));
    const r = await engine.placeBid({
      lotId: live.id, amount: decision.bid.amount, bidderProfileId: bidder.profileId, bidderWallet: bidder.wallet, paddleId: bidder.paddleId, via: 'house',
      message, signature, nonce, fundsBalance: HOUSE_FUNDS,
    });
    return r.ok ? r.live : null; // a lost race (someone bid a moment earlier) is a normal "no"
  } catch (e) {
    console.warn('house bidder skipped', (e as Error).message);
    return null;
  }
}

async function defaultKeys(): Promise<() => Keypair[] | null> {
  const [{ settlementAuthority }, { deriveBotKeys }] = await Promise.all([import('@/lib/chain/keys'), import('./rollover')]);
  return () => { try { return deriveBotKeys(settlementAuthority()); } catch { return null; } };
}
