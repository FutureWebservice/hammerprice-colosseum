import { describe, expect, it } from 'vitest';
import { apiPathUrl, hlsUrl, houseVideoEnabled, insecureTargetAllowed, mediaPath, newIngestSegment, RANDOM_SEGMENT_RE, senderAllowed, videoConfig, whipSessionUrl, whipUrl } from '../paths';

const BASE = { MEDIA_SERVER_URL: 'stream.example.test', MEDIAMTX_PUBLISH_USER: 'u', MEDIAMTX_PUBLISH_PASS: 'p', MEDIA_SERVER_API_URL: 'https://stream.example.test:9998', MEDIA_SERVER_API_KEY: 'k' };

describe('videoConfig', () => {
  it('reads the media-server settings and defaults the ports, the prefix and the house path', () => {
    const c = videoConfig(BASE)!;
    expect(c).toMatchObject({ scheme: 'https', host: 'stream.example.test', hlsPort: 8888, webrtcPort: 8889, apiBase: 'https://stream.example.test:9998', apiKey: 'k', prefix: 'hp', houseSegment: 'house', senders: 'operator' });
  });

  it('is null when anything essential is missing or malformed (the feature then has no video)', () => {
    expect(videoConfig({})).toBeNull();
    expect(videoConfig({ ...BASE, MEDIA_SERVER_URL: '' })).toBeNull();
    expect(videoConfig({ ...BASE, MEDIAMTX_PUBLISH_PASS: '' })).toBeNull();
    expect(videoConfig({ ...BASE, MEDIA_SERVER_URL: 'bad host' })).toBeNull();
    expect(videoConfig({ ...BASE, MEDIA_SERVER_URL: 'a.test/evil' })).toBeNull();
    expect(videoConfig({ ...BASE, MEDIA_SERVER_HLS_PORT: '99999' })).toBeNull();
    expect(videoConfig({ ...BASE, VIDEO_PATH_PREFIX: 'a/b' })).toBeNull();
    expect(videoConfig({ ...BASE, VIDEO_HOUSE_PATH: '../x' })).toBeNull();
  });

  it('never uses the prefix live: another app on the same server uses it', () => {
    expect(videoConfig({ ...BASE, VIDEO_PATH_PREFIX: 'live' })).toBeNull();
  });

  it('tolerates a protocol and a trailing slash', () => {
    expect(videoConfig({ ...BASE, MEDIA_SERVER_URL: 'https://Stream.Example.test/' })!.host).toBe('stream.example.test');
  });

  it('ignores an API URL that is not a clean https origin and falls back to no API', () => {
    for (const bad of ['http://stream.example.test:9998', 'https://u:p@stream.example.test:9998', 'https://stream.example.test:9998/v3', 'https://stream.example.test:9998?x=1', 'not a url']) {
      expect(videoConfig({ ...BASE, MEDIA_SERVER_API_URL: bad })!.apiBase, bad).toBeNull();
    }
    expect(videoConfig({ ...BASE, MEDIA_SERVER_API_URL: '' })!.apiKey).toBeNull();
  });

  it('refuses a loopback host in a real deployment', () => {
    expect(videoConfig({ ...BASE, MEDIA_SERVER_URL: '127.0.0.1:8888' })).toBeNull();
    expect(videoConfig({ ...BASE, MEDIA_SERVER_URL: 'localhost' })).toBeNull();
  });
});

describe('the insecure test target', () => {
  const LOCAL = { ...BASE, MEDIA_SERVER_URL: '127.0.0.1:4010', MEDIA_SERVER_API_URL: 'http://127.0.0.1:4010', MEDIA_SERVER_WEBRTC_PORT: '4010', VIDEO_ALLOW_INSECURE_TARGET: 'true' };
  it('allows plain http to a loopback fake only when the switch is on', () => {
    const c = videoConfig(LOCAL)!;
    expect(c).toMatchObject({ scheme: 'http', host: '127.0.0.1', hlsPort: 4010, webrtcPort: 4010, apiBase: 'http://127.0.0.1:4010' });
    expect(hlsUrl(c, 'hp/x')).toBe('http://127.0.0.1:4010/hp/x/index.m3u8');
    expect(videoConfig({ ...LOCAL, VIDEO_ALLOW_INSECURE_TARGET: undefined })).toBeNull();
  });
  it('is ignored on a production deployment (the e2e server runs as preview, where it can only name loopback)', () => {
    expect(insecureTargetAllowed({ VIDEO_ALLOW_INSECURE_TARGET: 'true', VERCEL_ENV: 'production' })).toBe(false);
    expect(videoConfig({ ...LOCAL, VERCEL_ENV: 'production' })).toBeNull();
    expect(insecureTargetAllowed({ VIDEO_ALLOW_INSECURE_TARGET: 'true', VERCEL_ENV: 'preview' })).toBe(true);
    expect(insecureTargetAllowed({ VIDEO_ALLOW_INSECURE_TARGET: 'yes', VERCEL_ENV: undefined })).toBe(false);
  });
  it('does not let a non-loopback host use plain http, switch or not', () => {
    const c = videoConfig({ ...BASE, VIDEO_ALLOW_INSECURE_TARGET: 'true', MEDIA_SERVER_API_URL: 'http://stream.example.test:9998' })!;
    expect(c.scheme).toBe('https');
    expect(c.apiBase).toBeNull();
  });
});

describe('paths and urls', () => {
  const c = videoConfig(BASE)!;
  it('builds the addresses from the configuration and a validated segment only', () => {
    const p = mediaPath(c, 'AbC_-123')!;
    expect(p).toBe('hp/AbC_-123');
    expect(hlsUrl(c, p)).toBe('https://stream.example.test:8888/hp/AbC_-123/index.m3u8');
    expect(whipUrl(c, p)).toBe('https://stream.example.test:8889/hp/AbC_-123/whip');
    expect(whipSessionUrl(c, p, 'sid')).toBe('https://stream.example.test:8889/hp/AbC_-123/whip/sid');
    expect(apiPathUrl(c, 'get', p)).toBe('https://stream.example.test:9998/v3/paths/get/hp/AbC_-123');
    expect(apiPathUrl({ ...c, apiBase: null }, 'kick', p)).toBeNull();
  });
  it('refuses a segment that is not one plain piece', () => {
    for (const bad of ['', 'a/b', '../x', 'a b', 'a?b', 'a#b', 'a%2fb', 'x'.repeat(65)]) expect(mediaPath(c, bad), bad).toBeNull();
  });
  it('makes a random segment per show: 16 bytes, url safe, never repeating', () => {
    const a = newIngestSegment();
    expect(a).toMatch(RANDOM_SEGMENT_RE);
    expect(newIngestSegment()).not.toBe(a);
    expect(mediaPath(c, a)).not.toBeNull();
  });
  it('the house path is the fixed one and the prefix is configurable', () => {
    expect(mediaPath(videoConfig({ ...BASE, VIDEO_HOUSE_PATH: 'demo', VIDEO_PATH_PREFIX: 'hpx' })!, 'demo')).toBe('hpx/demo');
  });
});

describe('who may send', () => {
  const base = { wallet: 'W', sellerWallet: 'S', isHouse: false, senders: 'operator' as const, operators: ['OP'] };
  it('by default only an operator wallet', () => {
    expect(senderAllowed({ ...base, wallet: 'OP' })).toBe(true);
    expect(senderAllowed({ ...base, wallet: 'S' })).toBe(false);
    expect(senderAllowed(base)).toBe(false);
  });
  it('the seller too when VIDEO_SENDERS=seller, but never on the house show', () => {
    expect(senderAllowed({ ...base, wallet: 'S', senders: 'seller' })).toBe(true);
    expect(senderAllowed({ ...base, wallet: 'S', senders: 'seller', isHouse: true })).toBe(false);
    expect(senderAllowed({ ...base, wallet: 'OP', isHouse: true })).toBe(true);
    expect(senderAllowed({ ...base, wallet: 'S', senders: 'seller', sellerWallet: null })).toBe(false);
  });
  it('VIDEO_SENDERS reads exactly "seller", anything else is operator', () => {
    expect(videoConfig({ ...BASE, VIDEO_SENDERS: 'seller' })!.senders).toBe('seller');
    expect(videoConfig({ ...BASE, VIDEO_SENDERS: 'SELLER' })!.senders).toBe('operator');
  });
});

describe('houseVideoEnabled', () => {
  it('is off unless HOUSE_VIDEO_ENABLED is exactly true', () => {
    expect(houseVideoEnabled({})).toBe(false);
    expect(houseVideoEnabled({ HOUSE_VIDEO_ENABLED: '1' })).toBe(false);
    expect(houseVideoEnabled({ HOUSE_VIDEO_ENABLED: 'true' })).toBe(true);
  });
});
