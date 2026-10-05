/**
 * The WHIP client against a stubbed RTCPeerConnection: it posts the offer to OUR route only, sends no credential of any kind, ends the
 * session with a DELETE on the Location it was given, and reports a refusal as `whip <status> <code>` so the page can say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WHIPClient } from '../whip-client';

class FakePC {
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remote: unknown = null;
  closed = false;
  onconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  addTransceiver() { return { setCodecPreferences: () => {} }; }
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\ns=offer\r\n' }; }
  async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
  async setRemoteDescription(d: unknown) { this.remote = d; }
  getSenders() { return []; }
  close() { this.closed = true; }
}

const stream = { getTracks: () => [{ kind: 'video' }, { kind: 'audio' }] } as unknown as MediaStream;
const calls: { url: string; init: RequestInit }[] = [];
let pc: FakePC;

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('RTCPeerConnection', function () { pc = new FakePC(); return pc; });
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] }) });
});
afterEach(() => { vi.unstubAllGlobals(); });

const answer = (status: number, headers: Record<string, string> = {}, body = 'v=0\r\ns=answer\r\n') =>
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(body, { status, headers }); });

describe('WHIPClient', () => {
  it('posts the offer as application/sdp to the given route with no Authorization header, and applies the answer', async () => {
    answer(201, { Location: '/api/streams/abc/whip/3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' });
    const c = new WHIPClient('/api/streams/abc/whip');
    await c.publish(stream);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/streams/abc/whip');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/sdp' });
    expect(init.body).toBe('v=0\r\ns=offer\r\n');
    expect(init.credentials).toBe('same-origin');
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'v=0\r\ns=answer\r\n' });
  });

  it('stop closes the connection and DELETEs the session the server named, again without any credential', async () => {
    answer(201, { Location: '/api/streams/abc/whip/3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' });
    const c = new WHIPClient('/api/streams/abc/whip');
    await c.publish(stream);
    await c.stop();
    expect(pc.closed).toBe(true);
    expect(calls[1]!.url).toBe('/api/streams/abc/whip/3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10');
    expect(calls[1]!.init).toEqual({ method: 'DELETE', credentials: 'same-origin' });
    await c.stop(); // a second stop sends nothing
    expect(calls).toHaveLength(2);
  });

  it('a refusal becomes "whip <status> <code>", read from the error body', async () => {
    answer(503, {}, JSON.stringify({ ok: false, code: 'video_unavailable', reason: 'x' }));
    await expect(new WHIPClient('/x').publish(stream)).rejects.toThrow('whip 503 video_unavailable');
    answer(403, {}, 'not json');
    await expect(new WHIPClient('/x').publish(stream)).rejects.toThrow(/^whip 403$/);
  });

  it('prefers H.264 so the media server can turn the stream into HLS', async () => {
    const order: string[][] = [];
    vi.stubGlobal('RTCPeerConnection', function () {
      pc = new FakePC();
      pc.addTransceiver = () => ({ setCodecPreferences: (c: { mimeType: string }[]) => { order.push(c.map((x) => x.mimeType)); } }) as never;
      return pc;
    });
    answer(201, { Location: '/l/3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' });
    await new WHIPClient('/x').publish(stream);
    expect(order[0]).toEqual(['video/H264', 'video/VP8']);
  });
});
