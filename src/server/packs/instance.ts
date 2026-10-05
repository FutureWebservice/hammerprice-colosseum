/**
 * The production instance of the pack service, built on first use so importing a route never needs DATABASE_URL or a key (the same pattern as
 * getSettlementService). Everything cluster-dependent comes from lib/chain/config.ts and lib/chain/cluster.ts: the USDC mint, the RPC list, the
 * fee wallet, the role keys. Tests inject their own service with setPackService.
 */
import { assertFeePayerPlatform, feeWalletAddress, resolveCluster, usdcMintFor } from '@/lib/chain/config';
import { assertClusterReady } from '@/lib/chain/cluster';
import { ChainError } from '@/lib/chain/errors';
import { houseSeller, settlementAuthority } from '@/lib/chain/keys';
import { createRpcPort } from '@/lib/chain/port';
import { makeRpc } from '@/lib/chain/rpc';
import { platformFeeBps } from '@/lib/auction/fees';
import { loadVrfKey } from '@/lib/vrf/key';
import { sponsorBudgetGuard } from '@/server/settlement/service';
import { readBeacon, readBeaconAfter } from './beacon';
import { createPackService, type PackService } from './service';
import { DEFAULT_DELIVERY_DEADLINE_S } from './payfirst';
import { telegramHooks } from '@/server/telegram/hooks';

let instance: PackService | undefined;
let override: PackService | undefined;
/** Tests only: pass undefined to go back to the real one. */
export function setPackService(s?: PackService): void { override = s; }

const RPC_TIMEOUT_MS = 6000;

/** PACK_DELIVERY_DEADLINE_S: how long a pack operator has to deliver a drawn card (A14). Default 24 h; clamped to 1 hour .. 7 days; anything unreadable is the default. */
export function deliveryDeadlineS(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.PACK_DELIVERY_DEADLINE_S ?? '').trim());
  return Number.isInteger(n) && n >= 3600 && n <= 7 * 86_400 ? n : DEFAULT_DELIVERY_DEADLINE_S;
}

export function getPackService(): PackService {
  if (override) return override;
  if (instance) return instance;
  let real: Promise<PackService> | undefined;
  const get = () => (real ??= import('@/db').then(({ db }) => {
    assertFeePayerPlatform();
    const fee = feeWalletAddress();
    if (!fee) throw new ChainError('paused', 'Payments are paused: the platform wallet is not configured.');
    const cluster = resolveCluster();
    return createPackService({
      db,
      chainFor: (c) => createRpcPort(c, makeRpc(c, { timeoutMs: RPC_TIMEOUT_MS })),
      sa: settlementAuthority(),
      houseOperator: houseSeller(), // the platform's own wallet: signs ONLY the devnet demo pack's delivery and refund (a house pack is refused on every other network); null when no house key is set up
      vrfKey: () => loadVrfKey(),
      beacon: (c) => readBeacon(makeRpc(c, { timeoutMs: RPC_TIMEOUT_MS })),
      beaconAfter: (c, slot) => readBeaconAfter(makeRpc(c, { timeoutMs: RPC_TIMEOUT_MS }), slot),
      usdcMint: (c) => usdcMintFor(c),
      feeWallet: fee,
      feeBps: platformFeeBps(),
      defaultCluster: cluster,
      assertCluster: (c) => assertClusterReady(c),
      spendGuard: (kind) => sponsorBudgetGuard(process.env, kind, 'pack'),
      deliveryDeadlineS: deliveryDeadlineS(),
      onDrawn: (id) => telegramHooks.packDelivery(id),
      onDeliveryDue: (id) => telegramHooks.packDelivery(id, true),
      // the devnet demo pack: a copy of the drawn replica is minted into the buyer's wallet (the same mint as "Get a test card", behind the same kill switch)
      mintDemoCopy: async ({ wallet, source }) => {
        const [{ flagOn }, { getDevnetService }, { PUBLIC_URL }] = await Promise.all([import('@/app/api/auctions/_shared/flags'), import('@/server/settlement/devnet'), import('@/lib/chain/replica-mint')]);
        if (!(await flagOn('mint'))) return null;
        return getDevnetService().mintCopy({ wallet, source, origin: new URL(PUBLIC_URL()).origin });
      },
    });
  }).catch((e) => { real = undefined; throw e; })); // a failed start is not remembered
  instance = {
    create: async (...a) => (await get()).create(...a),
    control: async (...a) => (await get()).control(...a),
    list: async (...a) => (await get()).list(...a),
    detail: async (...a) => (await get()).detail(...a),
    open: async (...a) => (await get()).open(...a),
    prepareDraw: async (...a) => (await get()).prepareDraw(...a),
    signDraw: async (...a) => (await get()).signDraw(...a),
    getDraw: async (...a) => (await get()).getDraw(...a),
    listDraws: async (...a) => (await get()).listDraws(...a),
    sweep: async (...a) => (await get()).sweep(...a),
    advanceDue: async (...a) => (await get()).advanceDue(...a),
    createHouse: async (...a) => (await get()).createHouse(...a),
    listDeliveries: async (...a) => (await get()).listDeliveries(...a),
  };
  return instance;
}
