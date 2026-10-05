/**
 * The two hooks the house rollover calls around creating a house show (owner: VRF).
 *
 *   prepareHouseShow()        before the show is created: how its lots are ordered and how long to wait before it starts (the wait is the
 *                             time the draw needs: commit, beacon, reveal). A drawn order needs FEATURE_VRF and a usable VRF key; otherwise the
 *                             catalogue order and no delay.
 *   afterHouseShowCreated(id) after it exists: create the draw request (a plain database insert) and start the first step in the background;
 *                             the thank-you draw of the house show that just ended is requested here as well.
 *
 * The rollover wraps both in try/catch and never lets either fail it: a show whose hook failed is simply a catalogue show (a drawn-order
 * show without a request opens in catalogue order, see lib/auction/engine.ts orderGateOf), and a request that never reveals defaults to the
 * catalogue order at its deadline.
 */
import { featureOn } from '@/lib/features';
import { assertClusterReady } from '@/lib/chain/cluster';
import { driveInBackground, requestRecentRaffles } from './driver';
import { vrfKey } from './key';
import { requestLotOrder } from './service';

export interface HouseShowOrder {
  orderMode: 'catalogue' | 'vrf';
  /** Seconds between creating the show and its scheduled start. */
  startDelayS: number;
}

/** Seconds the house show waits before it starts, so the first lot is rarely held back (the reveal normally lands in 45 to 60 s). */
export const HOUSE_START_DELAY_S = 60;

export async function prepareHouseShow(env: Record<string, string | undefined> = process.env): Promise<HouseShowOrder> {
  if (!(await featureOn('VRF', env)) || !vrfKey(env)) return { orderMode: 'catalogue', startDelayS: 0 };
  assertClusterReady(undefined, env); // a mainnet deployment with an incomplete configuration draws nothing and falls back to the catalogue
  return { orderMode: 'vrf', startDelayS: HOUSE_START_DELAY_S };
}

export async function afterHouseShowCreated(showId: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const key = vrfKey(env);
  if (!key) return;
  const deps = { key, now: () => new Date(), env };
  const made = await requestLotOrder(showId, deps);
  if (made?.created) await driveInBackground(made.id);
  // The house show before this one has just ended: its thank-you draw is requested now (a no-op when it had fewer than two human bidders).
  for (const id of await requestRecentRaffles(deps).catch(() => [] as string[])) await driveInBackground(id);
}
