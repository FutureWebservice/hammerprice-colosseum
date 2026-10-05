/**
 * The house stock: the devnet replica cards the house wallet owns (devnet_assets, written by the rollover's restock), and the lot terms a house show gives them.
 *
 * Terms are house convention for test assets, not a market price: the value of a card is the replica's `insured_value_usd`
 * attribute when the vault gave one, otherwise a flat figure by grade. Opening at half the value and a 5% increment follow
 * the seller wizard's defaults; reserve = opening price, so the lot sells to any bidder (a person above the house bidders wins).
 * Every card is a Metaplex Core replica; nothing else is ever listed.
 */
import { sql } from 'drizzle-orm';
import { lotListedSql } from '@/server/assets/listed';
import type { AssetMeta } from '@/server/auction/service';

export interface InventoryCard { mint: string; name: string; imageUrl: string | null; attributes: Record<string, unknown> }

export interface HouseLotTerms {
  mint: string;
  /** USDC base units: what the house bidders' 60% cap is measured against. */
  value: bigint;
  openingPrice: bigint;
  increment: bigint;
  reserve: bigint;
  meta: AssetMeta;
}

const USDC = 1_000_000n;
/** House convention (the same numbers the seller wizard defaults to): open at half the value, round to a whole USDC, at least 1; raise by 5%, floored to a whole USDC, at least 1. */
const openingOf = (value: bigint): bigint => { const r = ((value / 2n + USDC / 2n) / USDC) * USDC; return r > 0n ? r : USDC; };
const incrementOf = (value: bigint): bigint => { const r = ((value * 5n) / 100n / USDC) * USDC; return r > 0n ? r : USDC; };
/**
 * devnet_assets.attributes comes in two stored shapes (the Metaplex trait list, or the plain key/value object the first inventory run wrote;
 * the column may also arrive as JSON text). Everything here reads the key/value form with snake_case keys, so a trait list that stores
 * 'Replica of', 'Grading Company' or 'grade' reads the same way. Without this, cards stored as a trait list were all valued at the flat
 * grade-less $25, listed without set or grade, and could never serve as the template for a restock (the house show shrank by a card per sale).
 */
export function attributesRecord(raw: unknown): Record<string, unknown> {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (Array.isArray(v)) {
    const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return Object.fromEntries(v.flatMap((a): [string, unknown][] => (a && typeof a === 'object' && typeof (a as { trait_type?: unknown }).trait_type === 'string' ? [[key((a as { trait_type: string }).trait_type), (a as { value?: unknown }).value]] : [])));
  }
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
}
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** House estimate in whole USD: the vault's insured value when present, else by the numeric grade (10, 9, 8, lower). */
export function houseValueUsd(attributes: Record<string, unknown>): number {
  const insured = Number(attributes.insured_value_usd);
  if (Number.isFinite(insured) && insured >= 1) return Math.min(Math.round(insured), 100_000);
  const grade = /(\d+(?:\.\d)?)\s*$/.exec(String(attributes.grade ?? ''));
  const g = grade ? Number(grade[1]) : 0;
  return g >= 10 ? 120 : g >= 9 ? 60 : g >= 8 ? 40 : 25;
}

/**
 * The catalogue facts of a devnet replica (name, photo, set, grade) as the engine's `createShow` wants them. The attributes object is
 * the one lib/chain/replica-mint.ts `replicaAttributes` writes (`grade`, `grading_company`, `set`, ...). `insuredValue` is only what the
 * vault said (`insured_value_usd`), null otherwise.
 */
export function replicaMeta(card: InventoryCard): AssetMeta {
  const a = card.attributes;
  const insured = Number(a.insured_value_usd);
  return {
    name: card.name, imageUrl: card.imageUrl, setName: str(a.set), gradingCompany: str(a.grading_company), grade: str(a.grade), gradingId: str(a.grading_id),
    insuredValue: Number.isFinite(insured) && insured >= 1 ? BigInt(Math.round(insured)) * USDC : null, nftStandard: 'core',
  };
}

export function houseLotTerms(card: InventoryCard): HouseLotTerms {
  const value = BigInt(houseValueUsd(card.attributes)) * USDC;
  const openingPrice = openingOf(value);
  return { mint: card.mint, value, openingPrice, increment: incrementOf(value), reserve: openingPrice, meta: { ...replicaMeta(card), insuredValue: value } };
}

type Exec = { execute(q: ReturnType<typeof sql>): Promise<unknown> };
/** Raw `execute` rows skip drizzle's decoders: `attributes` may arrive as text. */
const rowsOf = <T,>(r: unknown): T[] => (r as { rows: T[] }).rows;

/**
 * Replicas the house owns that are free to list: not in a show that has not ended, not in the pool of a pack that is still on sale or already drawn out of it (FEATURE_PACKS), and not owed to a paid purchase that is still being delivered (whatever the status of its pack: a closed pack must not free a card a buyer already paid for), and not sold to a person (a live or settled
 * settlement with a human buyer). A lot a house bidder "won" never counts: no money moved and the card is still the house's.
 * Least recently listed first, so every card in stock gets its turn before any repeats.
 */
export async function availableInventory(x: Exec, houseWallet: string, limit: number): Promise<InventoryCard[]> {
  const res = await x.execute(sql`
    select da.mint, da.name, da.image_url as "imageUrl", da.attributes
    from devnet_assets da
    where da.owner_wallet = ${houseWallet}
      and not exists (select 1 from lots l where l.mint_address = da.mint and ${lotListedSql})
      and not exists (select 1 from lots l join shows s on s.id = l.show_id where l.mint_address = da.mint and (s.status <> 'ended' or l.state = 'open'))
      and not exists (
        select 1 from lots l join settlements st on st.lot_id = l.id join profiles b on b.id = st.buyer_id
        where l.mint_address = da.mint and b.is_bot = false and st.status = 'settled')
      and not exists (
        select 1 from pack_pool_cards pc join pack_definitions pd on pd.id = pc.pack_id
        where pc.asset = da.mint and (pc.status = 'drawn' or (pc.status in ('available', 'reserved') and pd.status in ('draft', 'live', 'paused', 'sold_out'))))
      and not exists (
        select 1 from pack_draws pw
        where pw.asset = da.mint and pw.status in ('drawn', 'delivering', 'undelivered'))
    order by (select max(s.created_at) from lots l join shows s on s.id = l.show_id where l.mint_address = da.mint) asc nulls first, da.minted_at asc
    limit ${limit}`);
  return rowsOf<{ mint: string; name: string; imageUrl: string | null; attributes: unknown }>(res).map((r) => ({
    mint: r.mint, name: r.name, imageUrl: r.imageUrl, attributes: attributesRecord(r.attributes),
  }));
}

/** The replica rows among `mints` (devnet_assets), for the card facts of a seller's own devnet cards. */
export async function replicaCards(x: Exec, mints: string[]): Promise<InventoryCard[]> {
  if (mints.length === 0) return [];
  const res = await x.execute(sql`select mint, name, image_url as "imageUrl", attributes from devnet_assets where mint in (${sql.join(mints.map((m) => sql`${m}`), sql`, `)})`);
  return rowsOf<{ mint: string; name: string; imageUrl: string | null; attributes: unknown }>(res).map((r) => ({
    mint: r.mint, name: r.name, imageUrl: r.imageUrl, attributes: attributesRecord(r.attributes),
  }));
}
