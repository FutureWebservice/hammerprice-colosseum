/**
 * The touch points the rest of the app calls when a state changes. The rule of this file: a Telegram problem must never reach the caller.
 *
 *   - Every hook returns at once. With FEATURE_TELEGRAM off (the default) it does nothing but read one environment variable.
 *   - The work runs after the response (`after()` of Next, like the VRF driver), or right away when there is no request (a script, a test).
 *   - Whatever fails inside is caught and logged without any value (no token, no URL), and the daily sweep sends what a hook missed.
 */
import { featureEnv } from '@/lib/features';
import type { BidEvent } from './notify';

const inflight = new Set<Promise<unknown>>();

function schedule(label: string, fn: () => Promise<unknown>): void {
  if (!featureEnv('TELEGRAM')) return;
  const run = (): Promise<void> => fn().then(() => undefined, (e) => console.error(`telegram: ${label} failed:`, (e as Error)?.message ?? 'error'));
  const p: Promise<void> = (async () => {
    try {
      const { after } = await import('next/server');
      after(run); // inside a request: after the response is sent
      return;
    } catch { /* no request scope (a script, a test), or next/server is not loadable here: run it now */ }
    await run();
  })().catch(() => undefined);
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Tests only: resolves when every hook started so far has finished. */
export async function settled(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

export const telegramHooks = {
  /** A bid was stored: the previous leader is outbid, and everyone else who bid hears when the lot is about to close. */
  bidPlaced(e: BidEvent & { highBid: bigint }): void {
    schedule('bid', async () => {
      const n = await import('./notify');
      await n.notifyOutbid(e);
      if (e.closesAt) await n.notifyEndingSoon({ lotId: e.lotId, lotName: e.lotName, showId: e.showId, closesAt: e.closesAt, highBid: e.highBid, exceptProfileId: e.bidderId });
    });
  },
  /** One or more lots of this show closed (timer, lazy close, buy now), a lot opened, the show went live or ended: buyers, watchers and the show-start list hear it. */
  showAdvanced(showId: string, what: { closed?: boolean; wentLive?: boolean; opened?: boolean; ended?: boolean }): void {
    schedule('advance', async () => {
      const n = await import('./notify');
      if (what.wentLive) await n.notifyShowStarted(showId);
      if (what.closed) await n.notifyWon({ showId });
      if (what.opened) await n.notifyLotsOpened(showId); // the people who watch this room hear that a lot opened
      if (what.ended) await n.notifyWatchEnded(showId); // and that the show is over: their watches stop
    });
  },
  /** A lot closed through a path that only knows the lot (the lazy close inside a late bid). */
  lotClosed(lotId: string): void {
    schedule('lot closed', async () => { await (await import('./notify')).notifyWon({ lotId }); });
  },
  /** A sale was created for a settlement id (Buy Now). */
  saleCreated(settlementId: string): void {
    schedule('sale', async () => { await (await import('./notify')).notifyWon({ settlementId }); });
  },
  /** A settlement was confirmed on chain. */
  settled(settlementId: string): void {
    schedule('settled', async () => { await (await import('./notify')).notifySettled({ settlementId }); });
  },
  /** A third-party pack purchase was paid and drawn (or its delivery deadline is close): the operator must deliver the card. */
  packDelivery(drawId: string, reminder = false): void {
    schedule('pack delivery', async () => { await (await import('./notify')).notifyPackDelivery(drawId, { reminder }); });
  },
  /** A chat message is waiting for the room operator. */
  chatPending(messageId: string): void {
    schedule('chat', async () => { await (await import('./notify')).notifyModeration(messageId); });
  },
};
