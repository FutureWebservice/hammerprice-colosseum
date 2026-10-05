/**
 * The bridge between the vault and the auction room.
 *
 * A VaultCard is a read from Collector Crypt's public catalogue; a lot is our row. Importing
 * one into a show is the only place those two shapes meet, so money-unit conversion (USD
 * float -> USDC base-unit bigint) and increment sizing live here and nowhere else.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, lots, lotState as lotStateEnum, profiles, showEvents, shows } from '@/db';
import type { VaultCard } from '@/lib/vault/collector-crypt';
import { isValidUuid } from '@/lib/uuid';

type LotState = (typeof lotStateEnum.enumValues)[number];

/** USD float (e.g. 149.99) -> USDC base units (6dp) as a bigint. Never floats past here. */
export function toBaseUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

/** 5% of the estimate, floored to whole USDC, minimum 1 USDC. */
export function defaultIncrement(estimateBaseUnits: bigint): bigint {
  // BigInt(...) rather than n-literals: the tsconfig target predates BigInt literals (see
  // the same note in lib/platform.ts).
  const oneUsdc = BigInt(1_000_000);
  const fivePercent = (estimateBaseUnits * BigInt(5)) / BigInt(100);
  const floored = (fivePercent / oneUsdc) * oneUsdc;
  return floored > BigInt(0) ? floored : oneUsdc;
}

/** Half the estimate, rounded to the nearest whole USDC, minimum 1 USDC - auction-house
 *  convention for where bidding opens (the reserve stays confidential, at or above this). */
export function defaultOpeningPrice(estimateBaseUnits: bigint): bigint {
  const oneUsdc = BigInt(1_000_000);
  const half = estimateBaseUnits / BigInt(2);
  const rounded = ((half + oneUsdc / BigInt(2)) / oneUsdc) * oneUsdc;
  return rounded > BigInt(0) ? rounded : oneUsdc;
}

/**
 * Insert one vault card as a lot in a show. The seller's price, if the card is listed, sets
 * the reserve; insuredValue is informational and stored as-is. The estimate that increment
 * and openingPrice are sized from is whichever of the two is present (price first - it is
 * what the owner asked).
 */
export async function importVaultCard(
  card: VaultCard,
  showId: string,
  sellerId: string,
  lotNumber: number,
) {
  const insuredValue = card.insuredValue != null ? toBaseUnits(card.insuredValue) : null;
  const reserve = card.price != null ? toBaseUnits(card.price) : null;
  const estimate = reserve ?? insuredValue ?? BigInt(1_000_000);

  const [row] = await db
    .insert(lots)
    .values({
      showId,
      sellerId,
      lotNumber,
      mintAddress: card.nftAddress,
      nftStandard: card.nftStandard,
      vaultRef: card.vault,
      name: card.name,
      setName: card.set,
      gradingCompany: card.gradingCompany,
      grade: card.grade,
      gradingId: card.gradingId,
      imageUrl: card.images.front ?? null,
      insuredValue,
      reserve,
      increment: defaultIncrement(estimate),
      openingPrice: defaultOpeningPrice(estimate),
    })
    .returning();

  return row;
}

/**
 * A lot with its money fields as strings. bigint does not survive JSON.stringify - every API
 * route that returns a lot must go through this rather than returning the row as-is.
 */
export function serializeLot(lot: typeof lots.$inferSelect) {
  return {
    ...lot,
    insuredValue: lot.insuredValue?.toString() ?? null,
    reserve: lot.reserve?.toString() ?? null,
    increment: lot.increment.toString(),
    openingPrice: lot.openingPrice.toString(),
    highBid: lot.highBid?.toString() ?? null,
  };
}

/** A show plus its lots, ordered by lot number. */
export async function getShowWithLots(showId: string) {
  if (!isValidUuid(showId)) return null;
  // The seller's wallet has to come back with the show, not just their profile id: the room
  // decides whether to render the auctioneer's rostrum by comparing the connected wallet
  // against it. Without the join a real seller never sees their own controls.
  const [row] = await db
    .select({ show: shows, sellerWalletAddress: profiles.walletAddress })
    .from(shows)
    .leftJoin(profiles, eq(profiles.id, shows.sellerId))
    .where(eq(shows.id, showId));
  if (!row) return null;
  const show = { ...row.show, sellerWalletAddress: row.sellerWalletAddress };
  const showLots = await db
    .select()
    .from(lots)
    .where(eq(lots.showId, showId))
    .orderBy(lots.lotNumber);
  return { show, lots: showLots };
}

/** What a link preview and the tab title need: the show's title and whether it is the demo room. One statement, no lots (the room page's metadata used to read the whole catalogue for this). */
export async function getShowHead(showId: string): Promise<{ title: string; isHouse: boolean } | null> {
  if (!isValidUuid(showId)) return null;
  const [row] = await db.select({ title: shows.title, isHouse: shows.isHouse }).from(shows).where(eq(shows.id, showId));
  return row ?? null;
}

/** Live shows, newest first, with a lot count. */
export async function getLiveShows() {
  return db
    .select({
      id: shows.id,
      sellerId: shows.sellerId,
      title: shows.title,
      description: shows.description,
      format: shows.format,
      status: shows.status,
      startedAt: shows.startedAt,
      createdAt: shows.createdAt,
      lotCount: sql<number>`count(${lots.id})`.mapWith(Number),
    })
    .from(shows)
    .leftJoin(lots, eq(lots.showId, shows.id))
    .where(eq(shows.status, 'live'))
    .groupBy(shows.id)
    .orderBy(desc(shows.createdAt));
}

/**
 * Open a lot for bidding and append the matching show_event, in one transaction. A lot state
 * change without its event is how a viewer's screen silently desyncs from the room.
 */
export async function openLot(lotId: string) {
  return db.transaction(async (tx) => {
    const [lot] = await tx
      .update(lots)
      .set({ state: 'open', openedAt: new Date() })
      .where(and(eq(lots.id, lotId), eq(lots.state, 'catalogued')))
      .returning();
    if (!lot) throw new Error('lot not found or not in catalogued state');
    if (lot.showId) {
      await tx.insert(showEvents).values({
        showId: lot.showId,
        kind: 'lot_opened',
        payload: { lotId: lot.id, lotNumber: lot.lotNumber },
      });
    }
    return lot;
  });
}

/** Close a lot into a terminal state (sold/passed/withdrawn), with its event. */
export async function closeLot(lotId: string, state: Extract<LotState, 'sold' | 'passed' | 'withdrawn'>) {
  return db.transaction(async (tx) => {
    const [lot] = await tx
      .update(lots)
      .set({ state, closedAt: new Date() })
      .where(and(eq(lots.id, lotId), eq(lots.state, 'open')))
      .returning();
    if (!lot) throw new Error('lot not found or not open');
    if (lot.showId) {
      await tx.insert(showEvents).values({
        showId: lot.showId,
        kind: `lot_${state}`,
        payload: { lotId: lot.id, lotNumber: lot.lotNumber, highBid: lot.highBid?.toString() ?? null },
      });
    }
    return lot;
  });
}
