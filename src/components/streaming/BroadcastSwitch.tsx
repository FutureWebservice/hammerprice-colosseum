'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ShowStatus } from '@/contracts/common';
import { videoFeatureOn } from '@/lib/streaming/client-flag';
import { call } from '@/components/sell/api';
import { useApiError } from '@/components/sell/useApiError';
import './video.css';

/** The video switch and the link to the broadcast page in the show manager. Nothing while the feature is off here, and no switch once the show ended. */
export default function BroadcastSwitch(props: { showId: string; videoEnabled: boolean; status: ShowStatus }) {
  return videoFeatureOn() && props.status !== 'ended' ? <Switch {...props} /> : null;
}

function Switch({ showId, videoEnabled }: { showId: string; videoEnabled: boolean; status: ShowStatus }) {
  const t = useTranslations('video');
  const locale = useLocale();
  const errorText = useApiError();
  const [on, setOn] = useState(videoEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clicked = useRef(false);

  // The catalogue the manager loaded can be 10 s old at the CDN; the playback route says what is on now (3 s). A click wins over a late answer.
  useEffect(() => {
    let cancelled = false;
    void call<{ enabled: boolean }>('GET', `/api/streams/${showId}/playback`).then((r) => { if (!cancelled && !clicked.current && r.ok) setOn(r.data.enabled); });
    return () => { cancelled = true; };
  }, [showId]);

  async function toggle() {
    clicked.current = true;
    setBusy(true);
    setError(null);
    const r = await call<{ video: { enabled: boolean } }>('POST', `/api/shows/${showId}/video`, { body: { enabled: !on } });
    if (r.ok) setOn(r.data.video.enabled);
    else setError(r.code === 'video_unavailable' ? t('manage.unavailable') : errorText(r));
    setBusy(false);
  }

  return (
    <span className="vd-switch" data-testid="video-switch" data-enabled={on}>
      <span className="sl-note" style={{ margin: 0 }}>{t('manage.label')}: <b data-testid="video-state">{on ? t('manage.on') : t('manage.off')}</b></span>
      <button type="button" className="sl-btn" data-testid="video-toggle" disabled={busy} onClick={toggle}>{busy ? t('manage.saving') : on ? t('manage.turnOff') : t('manage.turnOn')}</button>
      {on && <Link href={`/${locale}/sell/${showId}/broadcast`} className="sl-btn" data-testid="broadcast-link">{t('manage.broadcast')}</Link>}
      {error && <span className="sl-warn" role="alert">{error}</span>}
    </span>
  );
}
