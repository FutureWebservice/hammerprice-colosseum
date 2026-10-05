/**
 * Integration harness: a real Postgres 18 (embedded-postgres, all migrations applied), the REAL service imported against it,
 * and small raw-SQL helpers to arrange rows. Nothing touches Neon. Returns null when the server cannot start (tests then skip).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';

export const USDC = 1_000_000n;
export type Service = typeof import('../service');

/** A row from a raw pg query: untyped on purpose, the tests assert on the columns they read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface Env {
  pg: TestPg;
  pool: Pool;
  svc: Service;
  profile: (over?: { wallet?: string; banned?: boolean; bot?: boolean }) => Promise<{ id: string; wallet: string }>;
  show: (o: ShowOpts) => Promise<{ id: string; lots: string[] }>;
  paddle: (showId: string, profileId: string, over?: { maxBid?: bigint | null; hours?: number }) => Promise<{ id: string; number: number }>;
  bid: (lotId: string, p: { id: string; wallet: string }, amount: bigint, over?: Partial<import('@/contracts/services').PlaceBidInput>) => ReturnType<Service['placeBid']>;
  lot: (id: string) => Promise<Row>;
  events: (showId: string) => Promise<{ id: number; kind: string; payload: Row }[]>;
  stop: () => Promise<void>;
}

export interface LotOpts {
  state?: 'catalogued' | 'open' | 'sold' | 'passed' | 'withdrawn';
  opening?: bigint; increment?: bigint; reserve?: bigint | null;
  openedAt?: Date | null; closesAt?: Date | null; consign?: string;
  highBid?: bigint | null; highBidderId?: string | null; bidCount?: number; closedAt?: Date | null;
}
export interface ShowOpts {
  sellerId: string; status?: 'scheduled' | 'live' | 'ended'; rules?: Record<string, number>; settlementMode?: string; mode?: string;
  scheduledAt?: Date | null; isHouse?: boolean; cluster?: string | null; lots: LotOpts[];
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A random string that is valid base58 (the contracts' Wallet shape), so fixtures pass the zod schemas. */
const b58 = (n: number) => Array.from({ length: n }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
const wallet = () => b58(44);

export async function startEnv(): Promise<{ env: Env } | { skip: string }> {
  const r = await startTestPg({ poolMax: 30 });
  if ('skip' in r) return r;
  const pg = r.pg;
  process.env.DATABASE_URL = pg.url;
  const svc = await import('../service');
  // Idle sockets can see the server go away during teardown (57P01); that is expected there and must not fail the run.
  (globalThis as { __pool?: Pool }).__pool?.on('error', () => {});
  const pool = pg.pool;

  const profile: Env['profile'] = async (o = {}) => {
    const w = o.wallet ?? wallet();
    const { rows } = await pool.query(`insert into profiles (wallet_address, is_banned, is_bot) values ($1,$2,$3) returning id`, [w, o.banned ?? false, o.bot ?? false]);
    return { id: rows[0].id, wallet: w };
  };

  const show: Env['show'] = async (o) => {
    const { rows: [s] } = await pool.query(
      `insert into shows (seller_id, title, status, rules, settlement_mode, mode, scheduled_at, is_house, cluster, started_at)
       values ($1,'Test show',$2,$3::jsonb,$4,$5,$6,$7,$8, case when $9::text = 'live' then now() end) returning id`,
      [o.sellerId, o.status ?? 'live', JSON.stringify(o.rules ?? {}), o.settlementMode ?? 'onchain', o.mode ?? 'auto', o.scheduledAt ?? null, o.isHouse ?? false, o.cluster === undefined ? 'devnet' : o.cluster, o.status ?? 'live'],
    );
    const ids: string[] = [];
    for (const [n, l] of o.lots.entries()) {
      const { rows: [row] } = await pool.query(
        `insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price, reserve, state, opened_at, closes_at, closed_at, consign_status, high_bid, high_bidder_id, bid_count)
         values ($1,$2,$3,$4,'core',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
        [s.id, o.sellerId, n + 1, b58(44), `Lot ${n + 1}`, (l.increment ?? 5n * USDC).toString(), (l.opening ?? 50n * USDC).toString(),
          l.reserve === undefined ? (100n * USDC).toString() : l.reserve?.toString() ?? null, l.state ?? 'catalogued', l.openedAt ?? null, l.closesAt ?? null, l.closedAt ?? null,
          l.consign ?? 'ready', l.highBid?.toString() ?? null, l.highBidderId ?? null, l.bidCount ?? 0],
      );
      ids.push(row.id);
    }
    return { id: s.id, lots: ids };
  };

  const paddle: Env['paddle'] = async (showId, profileId, over = {}) => {
    const p = await svc.registerPaddle({
      showId, profileId, sessionPubkey: 'SessionPubkey1111111111111111111111111111111', maxBid: over.maxBid ?? null,
      validUntil: new Date(Date.now() + (over.hours ?? 5) * 3600_000), authMessage: 'paddle auth', authSignature: 'sig',
    });
    return { id: p.id, number: p.number };
  };

  let nonce = 0;
  const bid: Env['bid'] = (lotId, p, amount, over = {}) =>
    svc.placeBid({
      lotId, amount, bidderProfileId: p.id, bidderWallet: p.wallet, paddleId: null, via: 'wallet',
      message: `bid ${lotId} ${amount}`, signature: `sig-${amount}-${p.id}`, nonce: `n${++nonce}-${randomUUID().slice(0, 8)}`,
      fundsBalance: 1_000_000n * USDC, ...over,
    });

  return {
    env: {
      pg, pool, svc, profile, show, paddle, bid,
      lot: async (id) => (await pool.query(`select * from lots where id=$1`, [id])).rows[0],
      events: async (showId) => (await pool.query(`select id, kind, payload from show_events where show_id=$1 order by id`, [showId])).rows,
      // The service's own pool (module-level in @/db) must close before the server goes away, or its sockets raise an unhandled 57P01.
      stop: async () => { await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {}); await pg.stop(); },
    },
  };
}
