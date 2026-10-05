/**
 * The viewer's side and the seller's controls as static markup with the real DE and EN messages (no DOM library is installed): nothing
 * about video until the seller enabled it, nothing loaded before the viewer's click, a poster that names the host, and the same words in
 * both languages without dashes. The click-through and the network silence are proved in the browser (e2e e12).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('../video.css', () => ({}));
vi.mock('@/components/streaming/video.css', () => ({}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import en from '@/locales/en/video.json';
import de from '@/locales/de/video.json';
import enSell from '@/locales/en/sell.json';
import deSell from '@/locales/de/sell.json';
import StageMedia from '@/components/room/slots/StageMedia';
import VideoOption from '@/components/sell/slots/VideoOption';
import BroadcastLink from '@/components/sell/slots/BroadcastLink';
import { VideoView } from '../StageVideo';
import { errorKey } from '../WhipBroadcaster';

const MESSAGES = { en: { video: en, sell: enSell }, de: { video: de, sell: deSell } };
const render = (el: React.ReactElement, locale: 'en' | 'de' = 'en') => renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">{el}</NextIntlClientProvider>);
const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
const URL_ = 'https://stream.example.test:8888/hp/AbCdEfGhIjKlMnOpQrStUv/index.m3u8';
const noop = () => {};
const view = (pb: Parameters<typeof VideoView>[0]['pb'], o: { consent?: boolean; failed?: boolean; locale?: 'en' | 'de' } = {}) =>
  render(<VideoView pb={pb} consent={o.consent ?? false} failed={o.failed ?? false} onLoad={noop} onOff={noop} onError={noop} />, o.locale);

afterEach(() => { vi.unstubAllEnvs(); });

describe('the viewer', () => {
  it('sees nothing without a playback answer, when video is not enabled, when nobody sends, or after a failure', () => {
    expect(view(null)).toBe('');
    expect(view({ enabled: false, live: false, hlsUrl: null })).toBe('');
    expect(view({ enabled: true, live: false, hlsUrl: null })).toBe('');
    expect(view({ enabled: true, live: true, hlsUrl: URL_ }, { failed: true })).toBe('');
    expect(view({ enabled: true, live: true, hlsUrl: URL_ }, { failed: true, consent: true })).toBe('');
  });

  it('before the click: only a poster with the button and the host; no video element and no address of the stream in the page', () => {
    const html = view({ enabled: true, live: true, hlsUrl: URL_ });
    expect(html).toContain('data-testid="video-poster"');
    expect(html).toContain('Load live video');
    expect(html).toContain('Connection to stream.example.test');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('index.m3u8');
    expect(html).not.toContain('8888');
  });

  it('after the click: the player layer with the label that says the picture may lag and the server clock decides, and a button to turn it off', () => {
    const html = view({ enabled: true, live: true, hlsUrl: URL_ }, { consent: true });
    expect(html).toContain('<video');
    expect(html).toContain("Camera picture, may be a few seconds behind. The server&#x27;s clock decides.");
    expect(html).toContain('data-testid="video-off"');
    expect(html).not.toContain('data-testid="video-poster"');
  });

  it('has the same two states in German, with the host and the formal address', () => {
    const poster = view({ enabled: true, live: true, hlsUrl: URL_ }, { locale: 'de' });
    expect(poster).toContain('Live-Video laden');
    expect(poster).toContain('Verbindung zu stream.example.test');
    expect(view({ enabled: true, live: true, hlsUrl: URL_ }, { consent: true, locale: 'de' })).toContain('Kamerabild, kann einige Sekunden verzögert sein. Es gilt die Uhr des Servers.');
  });

  it('a malformed address shows nothing', () => {
    expect(view({ enabled: true, live: true, hlsUrl: 'nope' } as never)).toBe('');
  });

  it('the room slot renders nothing when video is not enabled, and nothing yet while the first playback answer is awaited', () => {
    expect(render(<StageMedia showId={SHOW} enabled={false} />)).toBe('');
    expect(render(<StageMedia showId={SHOW} enabled />)).toBe('');
  });
});

describe('the seller', () => {
  it('sees no checkbox and no switch while the feature is off in this deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_VIDEO', '');
    expect(render(<VideoOption enabled={false} onChange={noop} />)).toBe('');
    expect(render(<BroadcastLink showId={SHOW} videoEnabled status="live" />)).toBe('');
  });

  it('gets an unticked checkbox with the explanation, and the IP note only once it is ticked', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_VIDEO', 'true');
    const off = render(<VideoOption enabled={false} onChange={noop} />);
    expect(off).toContain('Live video (optional)');
    expect(off).toContain('Off by default.');
    expect(off).toContain('The video server then sees their IP address.');
    expect(off).not.toContain('checked');
    expect(off).not.toContain('data-testid="video-ip-note"');
    const on = render(<VideoOption enabled onChange={noop} />);
    expect(on).toContain('checked');
    expect(on).toContain('data-testid="video-ip-note"');
  });

  it('the German option text says it is off by default and who sees the IP address', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_VIDEO', 'true');
    const html = render(<VideoOption enabled={false} onChange={noop} />, 'de').replaceAll('&quot;', '"');
    expect(html).toContain('Live-Video (optional)');
    expect(html).toContain('Standardmäßig aus.');
    expect(html).toContain('Dabei erfährt der Video-Server ihre IP-Adresse.');
  });

  it('the manager shows the state, the switch and, only while on, the link to the broadcast page; nothing once the show ended', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_VIDEO', 'true');
    const off = render(<BroadcastLink showId={SHOW} videoEnabled={false} status="scheduled" />);
    expect(off).toContain('data-enabled="false"');
    expect(off).toContain('Turn on');
    expect(off).not.toContain('broadcast-link');
    const on = render(<BroadcastLink showId={SHOW} videoEnabled status="live" />);
    expect(on).toContain('Turn off');
    expect(on).toContain(`href="/en/sell/${SHOW}/broadcast"`);
    expect(render(<BroadcastLink showId={SHOW} videoEnabled status="ended" />)).toBe('');
  });
});

describe('the words', () => {
  const keys = (o: unknown, p = ''): string[] => Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'object' && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  const texts = (o: unknown): string[] => Object.values(o as Record<string, unknown>).flatMap((v) => (typeof v === 'object' && v ? texts(v) : [String(v)]));

  it('German and English have exactly the same keys', () => { expect(keys(de).sort()).toEqual(keys(en).sort()); });
  it('no empty text, no dash used as punctuation, no gradient talk', () => {
    for (const s of [...texts(de), ...texts(en)]) {
      expect(s.trim().length).toBeGreaterThan(1);
      expect(s).not.toMatch(/[\u2014–]/);
      expect(s).not.toMatch(/ - /);
    }
  });
  it('makes no claim about speed: no number of seconds and no "real time"', () => {
    for (const s of [...texts(de), ...texts(en)]) expect(s).not.toMatch(/\d+\s*(s|sec|seconds|sekunden)\b|real[- ]?time|echtzeit|latenz|latency/i);
  });
  it('every error key the broadcaster can produce has a text in both languages and the sell namespace knows the API codes it can show', () => {
    for (const k of ['denied', 'nocam', 'signin', 'forbidden', 'state', 'rate', 'unavailable', 'generic']) {
      expect((en.broadcast.errors as Record<string, string>)[k], k).toBeTruthy();
      expect((de.broadcast.errors as Record<string, string>)[k], k).toBeTruthy();
    }
    // The manager's switch says this (not the generic API text) when the server has no video settings, so a click is never answered with silence.
    expect(en.manage.unavailable).toBeTruthy();
    expect(de.manage.unavailable).toBeTruthy();
    for (const code of ['video_unavailable', 'feature_off', 'not_seller', 'wrong_state']) {
      expect((enSell.errors as Record<string, string>)[code], code).toBeTruthy();
      expect((deSell.errors as Record<string, string>)[code], code).toBeTruthy();
    }
  });
});

describe('errorKey', () => {
  it('maps the camera errors and the route statuses to their message keys', () => {
    expect(errorKey({ name: 'NotAllowedError' })).toBe('denied');
    expect(errorKey({ name: 'NotFoundError' })).toBe('nocam');
    expect(errorKey(new Error('whip 401 unauthenticated'))).toBe('signin');
    expect(errorKey(new Error('whip 403 not_seller'))).toBe('forbidden');
    expect(errorKey(new Error('whip 409 wrong_state'))).toBe('state');
    expect(errorKey(new Error('whip 429 rate_limited'))).toBe('rate');
    expect(errorKey(new Error('whip 503 video_unavailable'))).toBe('unavailable');
    expect(errorKey(new Error('whip 404'))).toBe('generic');
    expect(errorKey(new Error('boom'))).toBe('generic');
    expect(errorKey(undefined)).toBe('generic');
  });
});
