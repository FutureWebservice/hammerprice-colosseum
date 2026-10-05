'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import type { ShowDetail } from '@/contracts/api';
import type { PlaybackResponse } from '@/contracts/stream';
import { call, getShow, type ApiFail } from '@/components/sell/api';
import { useApiError } from '@/components/sell/useApiError';
import SignInGate from '@/components/sell/SignInGate';
import WhipBroadcaster from './WhipBroadcaster';
import '@/components/sell/sell.css';
import './video.css';

function Inner({ showId }: { showId: string }) {
  const t = useTranslations('video.broadcast');
  const errorText = useApiError();
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error'; error: ApiFail } | { kind: 'ready'; show: ShowDetail['show']; enabled: boolean }>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // The catalogue may be up to 10 s old at the CDN; whether video is on is asked of the playback route (3 s), so a seller who just switched it on is not told it is off.
    void Promise.all([getShow(showId), call<PlaybackResponse>('GET', `/api/streams/${showId}/playback`)]).then(([r, p]) => {
      if (!cancelled) setState(r.ok ? { kind: 'ready', show: r.data.show, enabled: p.ok ? p.data.enabled : r.data.show.video?.enabled === true } : { kind: 'error', error: r });
    });
    return () => { cancelled = true; };
  }, [showId]);

  if (state.kind === 'loading') return <p className="sl-note" role="status">{t('loading')}</p>;
  if (state.kind === 'error') return <p className="sl-warn" role="alert">{errorText(state.error)}</p>;
  const { show, enabled } = state;
  return (
    <>
      <h2 className="sl-h2" data-testid="broadcast-show">{show.title}</h2>
      {show.status === 'ended' ? <p className="sl-note" data-testid="broadcast-ended">{t('ended')}</p>
        : !enabled ? <p className="sl-note" data-testid="broadcast-off">{t('off')}</p>
        : <WhipBroadcaster showId={showId} />}
      <p className="sl-note"><Link href={`/sell/${showId}`} data-testid="broadcast-back">{t('back')}</Link></p>
    </>
  );
}

export default function BroadcastPage({ showId }: { showId: string }) {
  const t = useTranslations('video.broadcast');
  return (
    <div className="hp sl">
      <header className="sl-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="sl-h1">{t('title')}</h1>
        <p className="sl-lede">{t('lede')}</p>
      </header>
      <SignInGate><Inner showId={showId} /></SignInGate>
    </div>
  );
}
