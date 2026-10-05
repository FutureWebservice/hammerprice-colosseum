/**
 * Optional live video, server side: who may do what for which show, the per-show path, and the public playback answer.
 * Every entry point checks `featureOn('VIDEO')` first; a show answers with video only when its seller ticked the box.
 */
import { eq } from 'drizzle-orm';
import { ApiError } from '@/contracts/errors';
import type { PlaybackResponse } from '@/contracts/stream';
import { getDb } from '@/app/api/auctions/_shared/http';
import { profiles, showSecrets, shows } from '@/db/schema';
import { requireSessionProfile } from '@/lib/auth/session';
import { assertSameOrigin } from '@/lib/http/origin';
import { createMemo } from '@/lib/http/memo';
import { assertRate, rateLimitIp, rateLimitWallet } from '@/lib/http/ratelimit';
import { isAuctioneer, operatorWallets } from '@/lib/auctioneer';
import { featureOn } from '@/lib/features';
import { isValidUuid } from '@/lib/uuid';
import { isLive, kick } from './mediamtx';
import { hlsUrl, mediaPath, newIngestSegment, senderAllowed, videoConfig, type VideoConfig } from './paths';

export type ShowCtx = { params: Promise<{ showId: string }> };

/** The `:showId` segment; a malformed id can never name a row, so it is a 404. */
export async function showParam(ctx: ShowCtx): Promise<string> {
  const { showId } = await ctx.params;
  if (!isValidUuid(showId)) throw new ApiError('not_found', 'Show not found');
  return showId.toLowerCase();
}

interface VideoShow { id: string; sellerId: string; sellerWallet: string | null; isHouse: boolean; status: 'scheduled' | 'live' | 'ended'; videoEnabled: boolean }

async function loadShow(showId: string): Promise<VideoShow> {
  const [row] = await (await getDb())
    .select({ id: shows.id, sellerId: shows.sellerId, sellerWallet: profiles.walletAddress, isHouse: shows.isHouse, status: shows.status, videoEnabled: shows.videoEnabled })
    .from(shows)
    .leftJoin(profiles, eq(profiles.id, shows.sellerId))
    .where(eq(shows.id, showId));
  if (!row) throw new ApiError('not_found', 'Show not found');
  return row;
}

/**
 * The path of a show on the media server. The house show has a fixed one. Any other show gets 16 random bytes on first use
 * (`create`), kept in `show_secrets` (the old `publish_token` column is NOT NULL and unused, so it is filled with another random value).
 * Without `create` a show that never sent has no path, and null means "nobody has ever sent".
 */
async function pathFor(cfg: VideoConfig, show: VideoShow, create: boolean): Promise<string | null> {
  if (show.isHouse) return mediaPath(cfg, cfg.houseSegment);
  const db = await getDb();
  const read = async () => (await db.select({ p: showSecrets.ingestPath }).from(showSecrets).where(eq(showSecrets.showId, show.id)))[0]?.p ?? null;
  let segment = await read();
  if (!segment && create) {
    await db.insert(showSecrets).values({ showId: show.id, ingestPath: newIngestSegment(), publishToken: newIngestSegment() }).onConflictDoNothing();
    segment = await read();
  }
  return segment ? mediaPath(cfg, segment) : null;
}

const OFF: PlaybackResponse = { enabled: false, live: false, hlsUrl: null };
const playbackMemo = createMemo<PlaybackResponse>(3000);
/** Tests only. */
export const _clearPlaybackMemo = (): void => playbackMemo.clear();

/** `GET /api/streams/:showId/playback`: public, cached for 3 s. `hlsUrl` is set only while the seller enabled video and somebody is sending. */
export const playback = (showId: string): Promise<PlaybackResponse> =>
  playbackMemo.get(showId, async () => {
    if (!(await featureOn('VIDEO'))) return OFF;
    const cfg = videoConfig();
    if (!cfg) return OFF; // incomplete or malformed media-server settings: the room shows the photo and says nothing
    const show = await loadShow(showId);
    if (!show.videoEnabled) return OFF;
    const path = await pathFor(cfg, show, false);
    if (!path) return { enabled: true, live: false, hlsUrl: null };
    const live = await isLive(cfg, path);
    if (show.status === 'ended') {
      // The engine has no hook for "the show ended", so the first poll after the end disconnects a sender that is still there.
      if (live) void kick(cfg, path);
      return { enabled: true, live: false, hlsUrl: null };
    }
    return { enabled: true, live, hlsUrl: live ? hlsUrl(cfg, path) : null };
  });

export interface SenderContext { cfg: VideoConfig; path: string; show: VideoShow; wallet: string }

/**
 * The checks every sender call shares: same origin, per-address and per-wallet limits, the feature, the settings, a signed-in wallet that may
 * send for this show, a show with video enabled. `allowEnded` is for stopping a session, which must work after the show ended.
 */
export async function authorizeSender(req: Request, showId: string, o: { allowEnded?: boolean; walletLimitPerMin?: number } = {}): Promise<SenderContext> {
  assertSameOrigin(req);
  assertRate(await rateLimitIp('video', req, 30, 60));
  if (!(await featureOn('VIDEO'))) throw new ApiError('feature_off', 'Not found');
  const cfg = videoConfig();
  if (!cfg) throw new ApiError('video_unavailable', 'Live video is not available right now');
  const { session } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('video', session.wallet, o.walletLimitPerMin ?? 6, 60));
  const show = await loadShow(showId);
  if (!senderAllowed({ wallet: session.wallet, sellerWallet: show.sellerWallet, isHouse: show.isHouse, senders: cfg.senders, operators: operatorWallets() })) {
    throw new ApiError('not_seller', 'You may not send video for this show');
  }
  if (!show.videoEnabled) throw new ApiError('wrong_state', 'Live video is not switched on for this show');
  if (show.status === 'ended' && !o.allowEnded) throw new ApiError('wrong_state', 'The show has ended');
  const path = await pathFor(cfg, show, true);
  if (!path) throw new ApiError('video_unavailable', 'Live video is not available right now');
  return { cfg, path, show, wallet: session.wallet };
}

/** `POST /api/shows/:id/video`: the seller (or, on the house show, an operator) switches the video of one show. Not after the show ended. */
export async function setVideoEnabled(req: Request, showId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  if (!(await featureOn('VIDEO'))) throw new ApiError('feature_off', 'Not found');
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('video-toggle', session.wallet, 10, 3600));
  const show = await loadShow(showId);
  if (show.sellerId !== profile.id && !isAuctioneer(session.wallet, show.sellerWallet, { isHouse: show.isHouse })) throw new ApiError('not_seller', 'Only the seller changes this');
  if (show.status === 'ended') throw new ApiError('wrong_state', 'The show has ended');
  // Playback is off while the media-server settings are incomplete, so "on" would be stored, shown, and then read back as "off" everywhere else.
  if (enabled && !videoConfig()) throw new ApiError('video_unavailable', 'Live video is not set up on this server');
  await (await getDb()).update(shows).set({ videoEnabled: enabled }).where(eq(shows.id, showId));
  playbackMemo.clear();
  if (!enabled) {
    const cfg = videoConfig();
    const path = cfg ? await pathFor(cfg, show, false) : null;
    if (cfg && path) void kick(cfg, path); // switched off while sending: stop the picture
  }
  return { enabled };
}
