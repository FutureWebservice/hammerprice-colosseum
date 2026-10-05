/**
 * Optional live video (FEATURE_VIDEO, default off), contract only. The seller ticks a checkbox per show; viewers load the
 * picture only after a click, so no third-party connection is made before consent. The media host, the path and every
 * credential stay on the server: nothing in this file (or in any answer built from it) carries a host or a path, except
 * `hlsUrl`, which is returned only to a viewer who asked for the playback after clicking.
 */
import { z } from 'zod';

/** `show.video` in the show core and the live snapshot. `enabled` = the seller's choice AND the feature is on here. */
export const ShowVideo = z.object({ enabled: z.boolean() }).strict();
export type ShowVideo = z.infer<typeof ShowVideo>;

/** `POST /api/shows/:id/video`: the seller (or the operator) switches the video of one show on or off. */
export const VideoToggleRequest = z.object({ enabled: z.boolean() }).strict();
export const VideoToggleResponse = z.object({ video: ShowVideo }).strict();

/** `GET /api/streams/:showId/playback`. `hlsUrl` is set only when the show has video enabled and somebody is sending. */
export const PlaybackResponse = z
  .object({ enabled: z.boolean(), live: z.boolean(), hlsUrl: z.string().url().max(500).nullable() })
  .strict()
  .refine((p) => p.hlsUrl === null || (p.enabled && p.live), 'hlsUrl only while enabled and live');
export type PlaybackResponse = z.infer<typeof PlaybackResponse>;
