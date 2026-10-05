import { ApiError } from '@/contracts/errors';
import { route } from '@/lib/auth/route';
import { whipOffer } from '@/server/streams/mediamtx';
import { authorizeSender, showParam, type ShowCtx } from '@/server/streams/service';

export const runtime = 'nodejs';

const MAX_SDP_BYTES = 20 * 1024;

/** The request body as text, refused as soon as it is larger than `max` bytes (a declared length is only a hint). */
async function readCapped(req: Request, max: number): Promise<string> {
  if (Number(req.headers.get('content-length') ?? 0) > max) throw new ApiError('validation', 'The offer is too large');
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new ApiError('validation', 'The offer is too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * WHIP signaling hop. The sender's browser posts its SDP offer here with the session cookie; this route checks who it is, adds the publish
 * credential (which never leaves the server) and forwards the offer to the media server. The media then flows browser to media server directly.
 */
export const POST = route(async (req: Request, ctx: ShowCtx) => {
  const showId = await showParam(ctx);
  const a = await authorizeSender(req, showId);
  if (req.headers.get('content-type') !== 'application/sdp') throw new ApiError('validation', 'Content-Type must be application/sdp');
  const offer = await readCapped(req, MAX_SDP_BYTES);
  if (!offer.startsWith('v=0')) throw new ApiError('validation', 'That is not an SDP offer');
  const r = await whipOffer(a.cfg, a.path, offer);
  if (!r.ok) throw new ApiError('video_unavailable', 'Live video is not available right now');
  return new Response(r.answer, {
    status: 201,
    headers: { 'Content-Type': 'application/sdp', Location: `/api/streams/${showId}/whip/${r.sessionId}`, 'Cache-Control': 'no-store' },
  });
});
