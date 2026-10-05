'use client';

/**
 * /packs: the packs on sale on this network, from GET /api/packs, laid out like /rooms: the demo packs (tutorial) first, then the real packs from sellers,
 * then how packs work and how to offer one, then the honesty panel.
 */
import { useEffect, useState } from 'react';
import type { PackPoolCardView, PackView } from '@/contracts';
import { Link } from '@/lib/i18n';
import { OfferPackExplainer } from './OfferPack';
import PackState from './PackState';
import PackTile from './PackTile';
import { getPack, listPacks } from './api';
import { usePackT } from './usePackT';
import './packs.css';
import './packs-list.css';

type Load = { kind: 'loading' } | { kind: 'error'; code: string } | { kind: 'ready'; packs: PackView[] };

/** At most two house demo packs are shown; whatever the house runs is shown, nothing is invented. */
export const MAX_DEMO_PACKS = 2;
export const splitPacks = (packs: PackView[]): { demo: PackView[]; real: PackView[] } => ({
  demo: packs.filter((p) => p.operator.isHouse).slice(0, MAX_DEMO_PACKS),
  real: packs.filter((p) => !p.operator.isHouse),
});

export default function PacksIndex({ locale }: { locale: 'de' | 'en' }) {
  const t = usePackT();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [cards, setCards] = useState<Record<string, PackPoolCardView[]>>({});
  useEffect(() => {
    let stopped = false;
    setLoad({ kind: 'loading' });
    void listPacks().then((r) => { if (!stopped) setLoad(r.ok ? { kind: 'ready', packs: r.data.packs } : { kind: 'error', code: r.code }); });
    return () => { stopped = true; };
  }, [attempt]);
  // the pool preview of a demo pack comes from its detail (the list carries no cards)
  const demoIds = load.kind === 'ready' ? splitPacks(load.packs).demo.map((p) => p.id).join(',') : '';
  useEffect(() => {
    if (!demoIds) return undefined;
    let stopped = false;
    for (const id of demoIds.split(',')) void getPack(id).then((r) => { if (!stopped && r.ok) setCards((c) => ({ ...c, [id]: r.data.cards })); });
    return () => { stopped = true; };
  }, [demoIds]);

  const { demo, real } = load.kind === 'ready' ? splitPacks(load.packs) : { demo: [], real: [] };
  return (
    <div className="hp pk" data-testid="packs-index">
      <header className="pl-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="hp-h1">{t('title')}</h1>
        <p className="pk-lede">{t('lede')}</p>
        <p className="pl-head-cta">
          <Link href="/packs/manage" className="hpx-btn" data-testid="packs-head-offer">{t('list.offer')}</Link>
          <a href="#how" className="hpx-btn hpx-btn--ghost" data-testid="packs-head-how">{t('list.how')}</a>
        </p>
      </header>
      <div className="pl-body">
        {load.kind === 'loading' && <p className="pk-state" role="status">{t('loading')}</p>}
        {load.kind === 'error' && (load.code === 'feature_off'
          ? <PackState kind="unavailable" title={t('unavailable')} testId="packs-error" />
          : <PackState kind="error" title={t('error')} testId="packs-error" retry={<button type="button" className="pk-btn" onClick={() => setAttempt((n) => n + 1)}>{t('retry')}</button>} />)}
        {load.kind === 'ready' && (
          <>
            {demo.length > 0 && (
              <section className="pl-group pl-group--demo hpx-panel" data-testid="packs-demo" aria-labelledby="pl-demo-title">
                <h2 className="pl-group-title" id="pl-demo-title">{t('list.demoTitle')} <span className="hpx-chip hpx-chip--demo">{t('list.demoBadge')}</span></h2>
                <p className="pl-group-sentence">{t('list.demoSentence')}</p>
                <div className="pl-grid pl-grid--demo" data-testid="packs-demo-grid">
                  {demo.map((p) => <PackTile key={p.id} pack={p} locale={locale} demo cards={cards[p.id]} />)}
                </div>
                <p className="pl-demo-footer" data-testid="demo-footer">
                  {t('list.demoFooter')} <Link href="/packs/manage" className="hpx-btn" data-testid="demo-offer">{t('list.offer')}</Link>
                </p>
              </section>
            )}
            <section className="pl-group" data-testid="packs-real" aria-labelledby="real-packs">
              <h2 className="pl-group-title" id="real-packs">{t('list.realTitle')}</h2>
              <p className="pl-group-lede">{t('list.realLede')}</p>
              {real.length > 0 ? (
                <div className="pl-grid" data-testid="packs-grid">
                  {real.map((p) => <PackTile key={p.id} pack={p} locale={locale} />)}
                </div>
              ) : (
                <div className="pl-empty hpx-panel" data-testid="packs-empty">
                  <h3 className="pl-empty-title">{t('list.realEmptyTitle')}</h3>
                  <p>{t('list.realEmpty')}</p>
                  <p className="pl-empty-actions">
                    <Link href="/packs/manage" className="hpx-btn" data-testid="packs-empty-offer">{t('list.offer')}</Link>
                    <a href="#how" className="hpx-btn hpx-btn--ghost" data-testid="packs-empty-how">{t('list.how')}</a>
                  </p>
                </div>
              )}
            </section>
          </>
        )}
        <OfferPackExplainer />
      </div>
    </div>
  );
}
