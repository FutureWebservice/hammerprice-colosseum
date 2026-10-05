/**
 * The two services AUTH routes call but do not own: the auction engine (ENGINE, server/auction/service.ts)
 * and the chain reads (CHAIN, lib/chain). They are reached through these accessors so tests can inject fakes
 * with `setServices`; by default the real services are loaded lazily on first use.
 */
import type { AuctionService, ChainApi } from '@/contracts';

export type AuthServices = { auction: Pick<AuctionService, 'registerPaddle' | 'getLiveSnapshot' | 'commitmentsFor'>; chain: Pick<ChainApi, 'getUsdcBalance'> };

let wired: Partial<AuthServices> = {};

export function setServices(s: Partial<AuthServices>): void {
  wired = { ...wired, ...s };
}

// The real services, loaded on first use so that importing this folder (unit tests, the edge-free
// helpers) never opens a database connection or pulls the chain client in.
const realAuction: AuthServices['auction'] = {
  registerPaddle: async (i) => (await import('@/server/auction/service')).auction.registerPaddle(i),
  getLiveSnapshot: async (id) => (await import('@/server/auction/service')).auction.getLiveSnapshot(id),
  commitmentsFor: async (id, exclude) => (await import('@/server/auction/service')).auction.commitmentsFor(id, exclude),
};
const realChain: AuthServices['chain'] = {
  getUsdcBalance: async (wallet, cluster) => (await import('@/lib/chain/funds')).getUsdcBalance(wallet, cluster),
};

export function auctionService(): AuthServices['auction'] {
  return wired.auction ?? realAuction;
}

export function chainApi(): AuthServices['chain'] {
  return wired.chain ?? realChain;
}
