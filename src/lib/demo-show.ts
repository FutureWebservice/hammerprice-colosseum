/**
 * The one show the demo clock drives.
 *
 * LEGACY: this is the simulated "practice room" (src/components/auction/PracticeRoom.tsx), kept so old links still open and so the landing hero
 * can read its lots. It is no longer linked from the nav, the landing page, the rooms index or the docs, and /rooms never lists it. The product's
 * one DEMO room is the house room (/room/house, src/lib/house-room.ts), which takes real signed devnet bids.
 *
 * Its id was copied into three files that each needed to ask "is this the practice show?" - the room,
 * the landing page and now the schedule. One constant, so a fourth reader cannot drift.
 */
export const DEMO_SHOW_ID = 'de5a9c8b-6105-43e5-9875-604642f2234e';

/**
 * The profile that owns the seed shows. It is not a base58 address (it contains "l"), so no
 * signed-in wallet can ever be it. The rooms list leaves the shows of this profile out unless they are house shows.
 */
export const SEED_SELLER_WALLET = 'HPDemoSe11er1111111111111111111111111111';
