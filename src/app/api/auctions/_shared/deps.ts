/**
 * The services LIVE routes call but do not own: the auction engine (ENGINE), the chain reads (CHAIN) and the
 * settlement sweep (CHAIN). Reached through these accessors so tests can inject fakes with `setLiveServices`
 * (the same pattern as lib/auth/deps.ts); by default the real services load lazily on first use, so importing a
 * route never opens a database connection or builds a chain client.
 */
import type { AssetReadiness, AuctionService, Cluster } from '@/contracts';

type Engine = typeof import('@/server/auction/service');

export interface LiveServices {
  auction: Pick<AuctionService, 'placeBid' | 'advanceShow' | 'sweep' | 'getLiveSnapshot' | 'getCatalogue' | 'listShows' | 'controlLot' | 'buyNow'> &
    Pick<Engine, 'createShow' | 'patchLot' | 'startShow' | 'endShow' | 'cancelShow' | 'pauseShow' | 'resumeShow'>;
  chain: {
    getUsdcBalance(wallet: string, cluster?: Cluster): Promise<bigint>;
    /** readAsset + evaluateAssetReadiness for one mint: can `seller` consign it? Throws ApiError('rpc_unavailable') when the chain cannot answer. */
    readiness(mint: string, seller: string, cluster?: Cluster): Promise<AssetReadiness>;
  };
  /** The settlement sweep (CHAIN's runSettlementSweep, called lazily by the house room read). Throws ApiError('paused') while payments are paused. */
  settlement: { sweep(now?: Date): Promise<{ expired: number; finalized: number }> };
}

let wired: Partial<LiveServices> = {};
export const setLiveServices = (s: Partial<LiveServices>): void => { wired = { ...wired, ...s }; };

const engine = () => import('@/server/auction/service');
const realAuction: LiveServices['auction'] = {
  placeBid: async (i) => (await engine()).placeBid(i),
  advanceShow: async (id, now) => (await engine()).advanceShow(id, now),
  sweep: async (now) => (await engine()).sweep(now),
  getLiveSnapshot: async (id) => (await engine()).getLiveSnapshot(id),
  getCatalogue: async (id) => (await engine()).getCatalogue(id),
  listShows: async (q) => (await engine()).listShows(q),
  createShow: async (i) => (await engine()).createShow(i),
  controlLot: async (i) => (await engine()).controlLot(i),
  buyNow: async (i) => (await engine()).buyNow(i),
  patchLot: async (i) => (await engine()).patchLot(i),
  startShow: async (id, a) => (await engine()).startShow(id, a),
  endShow: async (id, a) => (await engine()).endShow(id, a),
  cancelShow: async (id, a) => (await engine()).cancelShow(id, a),
  pauseShow: async (id, a) => (await engine()).pauseShow(id, a),
  resumeShow: async (id, a) => (await engine()).resumeShow(id, a),
};
const realChain: LiveServices['chain'] = {
  getUsdcBalance: async (w, c) => (await import('@/lib/chain/funds')).getUsdcBalance(w, c),
  readiness: async (mint, seller, c) => {
    const a = await import('@/lib/chain/asset');
    return a.evaluateAssetReadiness(await a.readAsset(mint, c), { seller });
  },
};
const realSettlement: LiveServices['settlement'] = {
  sweep: async (now) => (await import('@/server/settlement/sweep')).runSettlementSweep(now),
};

export const auctionService = (): LiveServices['auction'] => wired.auction ?? realAuction;
export const chainService = (): LiveServices['chain'] => wired.chain ?? realChain;
export const settlementService = (): LiveServices['settlement'] => wired.settlement ?? realSettlement;
