'use client';

/**
 * The DEMO label. The house runs one live demo room (the house show) and one timed demo lot at a time, plus the house pack: the only places
 * where Hammerprice itself owns the cards and runs labelled bots, each labelled DEMO and as a tutorial. Everything a seller makes is a different, unlabelled room.
 *
 * `DemoBadge` is the small pill (room header, cards, verify page, pack tiles); `DemoNote` is the one plain sentence that says what is demo.
 * Both read the `rooms` messages (rooms.demo.*), so the words are the same on every page.
 */
import { useTranslations } from 'next-intl';
import './room.css';

export function DemoBadge({ className = '' }: { className?: string }) {
  const t = useTranslations('rooms');
  return (
    <span className={`hp-demo-pill ${className}`.trim()} data-testid="demo-badge" title={t('demo.sentence')}>
      {t('demo.badge')}
    </span>
  );
}

/** "Tutorial: practise bidding here. The labelled bots never outbid a person." The money and the network are named where a person acts (faucet, network line, footer), not here. */
export function DemoNote({ className = '', kind }: { className?: string; kind?: 'live' | 'timed' }) {
  const t = useTranslations('rooms');
  return (
    <p className={`hp-demo-note ${className}`.trim()} role="note" data-testid="demo-note">
      <span className="hp-demo-note-tag">{t('demo.badge')}</span> {kind ? <><strong>{t(kind === 'timed' ? 'demo.tutorialTimed' : 'demo.tutorialLive')}.</strong> {t('demo.bots')}</> : t('demo.sentence')}
    </p>
  );
}
