'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PlaybackResponse } from '@/contracts/stream';
import { HlsPlayer } from './HlsPlayer';
import './video.css';

const POLL_MS = 10_000;

/** A viewer on a data-saver connection never loads video on its own. */
const saveData = (): boolean => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

// The key is written out in each call so that src/legal/__tests__/audit.test.ts can see it (it must be listed in the cookies table).
const readConsent = (showId: string): boolean => { try { return sessionStorage.getItem(`hp.video.${showId}`) === '1'; } catch { return false; } };
const writeConsent = (showId: string, on: boolean): void => { try { if (on) sessionStorage.setItem(`hp.video.${showId}`, '1'); else sessionStorage.removeItem(`hp.video.${showId}`); } catch { /* storage blocked: the consent then lasts until the page closes */ } };

/**
 * The optional live video in the room stage. Three gates, each off by default: the seller ticked the box (the slot renders this only then),
 * somebody is sending (the playback poll says so), and THIS viewer clicked "Load live video" for THIS show in THIS browser session. Until
 * the click nothing is requested from the video host: the poll goes to our own server, which alone knows the host. Any failure hides the
 * player and leaves the photo, silently.
 */
export function StageVideo({ showId }: { showId: string }) {
  const [pb, setPb] = useState<PlaybackResponse | null>(null);
  const [consent, setConsent] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setConsent(readConsent(showId)); }, [showId]);

  useEffect(() => {
    if (saveData()) return undefined;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const r = await fetch(`/api/streams/${showId}/playback`, { cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal });
          if (r.ok) setPb((await r.json()) as PlaybackResponse);
        } catch { /* offline or aborted: keep the last answer */ }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [showId]);

  useEffect(() => { if (pb && !pb.live) setFailed(false); }, [pb]);

  const onError = useCallback(() => setFailed(true), []);
  return (
    <VideoView
      pb={pb} consent={consent} failed={failed} onError={onError}
      onLoad={() => { writeConsent(showId, true); setConsent(true); }}
      onOff={() => { writeConsent(showId, false); setConsent(false); }}
    />
  );
}

/** What the viewer sees, as a pure function of the playback answer, their consent and a failure. Nothing here touches the network. */
export function VideoView({ pb, consent, failed, onLoad, onOff, onError }: {
  pb: PlaybackResponse | null; consent: boolean; failed: boolean; onLoad: () => void; onOff: () => void; onError: () => void;
}) {
  // The words are only needed once there is something to show, so the empty state needs no message provider.
  if (!pb?.enabled || !pb.live || !pb.hlsUrl || failed) return null;
  let host = '';
  try { host = new URL(pb.hlsUrl).hostname; } catch { return null; }
  return <VideoBody url={pb.hlsUrl} host={host} consent={consent} onLoad={onLoad} onOff={onOff} onError={onError} />;
}

function VideoBody({ url, host, consent, onLoad, onOff, onError }: { url: string; host: string; consent: boolean; onLoad: () => void; onOff: () => void; onError: () => void }) {
  const t = useTranslations('video');

  if (!consent) {
    return (
      <div className="vd-poster" data-testid="video-poster">
        <button type="button" className="vd-btn" data-testid="video-load" onClick={onLoad}>{t('stage.load')}</button>
        <small data-testid="video-host">{t('stage.connect', { host })}</small>
      </div>
    );
  }
  return (
    <div className="vd-layer" data-testid="video-layer">
      <HlsPlayer
        src={url}
        title={t('stage.title')}
        isLive
        onError={onError}
        labels={{ play: t('stage.play'), pause: t('stage.pause'), mute: t('stage.mute'), unmute: t('stage.unmute'), fullscreen: t('stage.fullscreen') }}
      />
      <div className="vd-bar">
        <span>{t('stage.mark')}</span>
        <button type="button" className="vd-btn vd-btn--ghost" data-testid="video-off" onClick={onOff}>{t('stage.turnOff')}</button>
      </div>
    </div>
  );
}
