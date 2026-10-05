/**
 * The live example of verified randomness on /about: the proof page of the newest drawn lot order of a house show, the same
 * `vrf_requests` row the room's "See the proof" link (FairnessChip) opens as `/verify/random/<requestId>`. null when none exists
 * (the feature is off, no house show has been drawn yet, or the database cannot be reached); the page then links to the house room.
 */
export async function houseProofHref(): Promise<string | null> {
  try {
    const { db, shows, vrfRequests } = await import('@/db');
    const { and, desc, eq, sql } = await import('drizzle-orm');
    const [row] = await db
      .select({ id: vrfRequests.id })
      .from(vrfRequests)
      .innerJoin(shows, and(eq(vrfRequests.subjectType, 'show'), eq(vrfRequests.subjectId, sql`${shows.id}::text`)))
      .where(and(eq(vrfRequests.purpose, 'lot_order'), eq(vrfRequests.status, 'revealed'), eq(shows.isHouse, true)))
      .orderBy(desc(vrfRequests.revealedAt))
      .limit(1);
    return row ? `/verify/random/${row.id}` : null;
  } catch {
    return null;
  }
}
