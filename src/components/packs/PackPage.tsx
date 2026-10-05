'use client';

/**
 * /packs/[id]: the pack, its odds, its whole pool and its commitment (all before anyone buys), the buy panel with the opening, and the public
 * log of openings. Everything is read from the API; nothing on the page is fixed copy about a particular pack.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PackDetailResponse } from '@/contracts';
import { Link } from '@/lib/i18n';
import BuyPanel from './BuyPanel';
import CommitBox from './CommitBox';
import DrawLog from './DrawLog';
import OddsTable from './OddsTable';
import PackArt from './PackArt';
import PackState from './PackState';
import PoolGrid from './PoolGrid';
import { getPack } from './api';
import { shortAddress } from './format';
import { usePackT } from './usePackT';
import { DemoBadge } from '@/components/room/DemoBadge';
import './packs.css';

type Load = { kind: 'loading' } | { kind: 'error'; code: string } | { kind: 'ready'; data: PackDetailResponse };

export default function PackPage({ packId, locale }: { packId: string; locale: 'de' | 'en' }) {
  const t = usePackT();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [logKey, setLogKey] = useState('0');
  const [slot, setSlot] = useState<HTMLElement | null>(null); // where the full-width opening is rendered
  const [reveal, setReveal] = useState(false);

  const refresh = useCallback(async () => {
    const r = await getPack(packId);
    setLoad(r.ok ? { kind: 'ready', data: r.data } : { kind: 'error', code: r.code });
  }, [packId]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The pool and the counters move when somebody buys; a calm refresh keeps the page honest.
  useEffect(() => {
    const id = setInterval(() => { void refresh(); }, 15_000);
    return () => clearInterval(id);
  }, [refresh]);
  const onSettled = useCallback(() => { setLogKey(String(Date.now())); void refresh(); }, [refresh]);

  if (load.kind === 'loading') return <div className="hp pk"><div className="pk-wrap"><p className="pk-state" role="status">{t('loading')}</p></div></div>;
  if (load.kind === 'error') {
    return (
      <div className="hp pk"><div className="pk-wrap pk-head">
        <Link href="/packs" className="pk-back">{t('back')}</Link>
        {load.code === 'feature_off'
          ? <PackState kind="unavailable" title={t('unavailable')} testId="pack-error" />
          : <PackState kind="notFound" title={t('detail.notFound')} testId="pack-error" catalogue />}
      </div></div>
    );
  }

  const { pack, cards } = load.data;
  const name = pack.name[locale];
  const tierLabel = Object.fromEntries(pack.odds.map((o) => [o.tier, o.label[locale]]));
  return (
    <div className="hp pk" data-testid="pack-page" data-pack={pack.id} data-reveal={reveal ? 'true' : 'false'}>
      <div className="pk-reveal-slot" ref={setSlot} />
      <div className="pk-wrap">
        <header className="pk-head">
          <Link href="/packs" className="pk-back">{t('back')}</Link>
          <h1 className="pk-title">{name}</h1>
          <span className={`pk-badge pk-badge--${pack.status}`}>{t(`status.${pack.status}`)}</span>
          {pack.description && <p className="pk-lede" style={{ marginTop: 12 }}>{pack.description[locale]}</p>}
        </header>
        <div className="pk-detail">
          <div className="pk-side">
            <PackArt name={name} seed={pack.id} tag={pack.operator.isHouse ? t('tile.houseTag') : undefined} odds={pack.odds} count={pack.pool.total} large />
            <div style={{ width: '100%' }}>
              <BuyPanel pack={pack} locale={locale} onSettled={onSettled} revealSlot={slot} onReveal={setReveal} />
            </div>
          </div>
          <div>
            <dl className="pk-facts">
              <div className="pk-fact"><dt>{t('detail.operator')}</dt><dd>{pack.operator.isHouse ? <><DemoBadge /> {t('detail.operatorHouse')}</> : <span className="pk-mono">{shortAddress(pack.operator.wallet)}</span>}</dd></div>
              <div className="pk-fact"><dt>{t('detail.mode')}</dt><dd>{t(pack.mode === 'chance' && pack.operator.isHouse ? 'mode.chanceHouse' : `mode.${pack.mode}`)}</dd></div>
              <div className="pk-fact"><dt>{t('detail.cap')}</dt><dd>{t('detail.capValue', { cap: pack.perWalletDailyCap })}</dd></div>
            </dl>
            <section className="pk-section" aria-labelledby="odds-h">
              <h2 id="odds-h">{t('odds.title')}</h2>
              <OddsTable pack={pack} locale={locale} />
            </section>
            <section className="pk-section" aria-labelledby="pool-h">
              <h2 id="pool-h">{t('pool.title')}</h2>
              <p>{t('pool.lede', { remaining: pack.pool.remaining, total: pack.pool.total })}</p>
              <PoolGrid pack={pack} cards={cards} locale={locale} />
            </section>
            <section className="pk-section" aria-labelledby="commit-h">
              <h2 id="commit-h">{t('commit.title')}</h2>
              <CommitBox pack={pack} locale={locale} />
            </section>
            <section className="pk-section" aria-labelledby="log-h">
              <h2 id="log-h">{t('log.title')}</h2>
              <DrawLog packId={pack.id} refreshKey={logKey} tierLabel={tierLabel} />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
