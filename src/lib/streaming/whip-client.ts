/**
 * WHIP client: sends the browser's camera and microphone to the signaling route of this site, which forwards the offer to the media server.
 * This client holds no secret, authenticates with the session cookie only, and talks to nothing but our own origin (the media then flows browser to
 * media server over WebRTC). Trickle ICE is not used; the offer waits for candidate gathering.
 */

export interface WHIPClientOptions {
  iceServers?: RTCIceServer[];
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  /** How long to wait for ICE candidates before sending the offer (default 2000 ms). */
  iceGatheringTimeout?: number;
}

export class WHIPClient {
  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;
  private readonly iceGatheringTimeout: number;

  constructor(private readonly whipUrl: string, private readonly options: WHIPClientOptions = {}) {
    this.iceGatheringTimeout = options.iceGatheringTimeout ?? 2000;
  }

  /** Start sending `stream`. Throws an Error whose message is the HTTP status (`whip 503`) when the route refuses; the caller maps it to words. */
  async publish(stream: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers ?? [], bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.onconnectionstatechange = () => this.options.onConnectionStateChange?.(pc.connectionState);

    for (const track of stream.getTracks()) {
      if (track.kind === 'video') this.preferH264(pc.addTransceiver(track, { streams: [stream] }));
      else pc.addTrack(track, stream);
    }

    await pc.setLocalDescription(await pc.createOffer());
    await this.waitForIceGathering(pc);
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local description');

    const res = await fetch(this.whipUrl, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: sdp, credentials: 'same-origin' });
    if (res.status !== 201) {
      const code = await res.json().then((j: { code?: string }) => j.code).catch(() => undefined);
      throw new Error(`whip ${res.status}${code ? ` ${code}` : ''}`);
    }
    const location = res.headers.get('Location');
    // Our route always answers with a path on this origin; anything else is ignored rather than followed.
    if (location && location.startsWith('/') && !location.startsWith('//')) this.resourceUrl = location;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  }

  /** Stop sending: ends the media, closes the connection and tells the server to end the session (best effort). The caller stops the camera tracks. */
  async stop(): Promise<void> {
    this.pc?.close();
    this.pc = null;
    const url = this.resourceUrl;
    this.resourceUrl = null;
    if (url) {
      try { await fetch(url, { method: 'DELETE', credentials: 'same-origin' }); } catch { /* the session ends by itself when the connection is gone */ }
    }
  }

  /** Switch camera without a new session. */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    await this.pc?.getSenders().find((s) => s.track?.kind === track.kind)?.replaceTrack(track);
  }

  get connectionState(): RTCPeerConnectionState | 'new' { return this.pc?.connectionState ?? 'new'; }

  /** H.264 first: the media server turns the stream into HLS for viewers, and it cannot do that with the browser's VP8 default. */
  private preferH264(transceiver: RTCRtpTransceiver): void {
    const codecs = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities('video')?.codecs : undefined;
    if (!codecs || !transceiver.setCodecPreferences) return;
    const isH264 = (c: RTCRtpCodec) => c.mimeType.toLowerCase() === 'video/h264';
    try { transceiver.setCodecPreferences([...codecs.filter(isH264), ...codecs.filter((c) => !isH264(c))]); } catch { /* keep the default order */ }
  }

  private waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, this.iceGatheringTimeout);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      };
    });
  }
}
