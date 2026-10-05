'use client';

import type { PackPoolCardView, PackView } from '@/contracts';
import { Link } from '@/lib/i18n';
import OddsBar from './OddsBar';
import PackArt from './PackArt';
import { shortAddress, usd } from './format';
import { usePackT } from './usePackT';

/** The delivery record of a seller, as one line (the same numbers the pack page shows before paying). */
export function recordLine(pack: Pick<PackView, 'operatorRecord'>, t: (k: string, v?: Record<string, string | number>) => string): string {
  const r = pack.operatorRecord;
  return r && (r.delivered > 0 || r.undelivered > 0) ? t('list.record', { delivered: r.delivered, undelivered: r.undelivered }) : t('list.recordNone');
}

/**
 * One pack in the catalogue, in the visual language of a room card. `demo` is the house tutorial pack (Demo chip, tutorial line, a few cards of the pool, the
 * yellow "Open demo pack" button); otherwise it is a real pack of a seller (cover, seller, price, odds bar, pool size, the seller's delivery record).
 */
export default function PackTile({ pack, locale, demo = false, cards }: { pack: PackView; locale: 'de' | 'en'; demo?: boolean; cards?: PackPoolCardView[] }) {
  const t = usePackT();
  const name = pack.name[locale];
  const preview = (cards ?? []).filter((c) => c.imageUrl).slice(0, 4);
  return (
    <article className={`pl-card hpx-panel${demo ? ' pl-card--demo' : ''}`} data-testid={demo ? 'demo-pack-tile' : 'pack-tile'} data-pack={pack.id}>
      <div className="pl-media">
        <div className="pl-media-top">
          {demo ? <span className="hpx-chip hpx-chip--demo" data-testid="demo-badge">{t('list.demoBadge')}</span> : <span className={`hpx-chip${pack.status === 'live' ? ' hpx-chip--gold' : ' hpx-chip--dim'}`}>{t(`status.${pack.status}`)}</span>}
          <span className="hpx-chip">{t('list.poolSize', { total: pack.pool.total })}</span>
        </div>
        <PackArt name={name} seed={pack.id} tag={demo ? t('tile.houseTag') : undefined} odds={pack.odds} count={pack.pool.total} />
      </div>
      <div className="pl-body-card">
        <h3 className="pl-name">{name}</h3>
        {demo && <p className="pl-tutorial" data-testid="tutorial-line">{t('list.demoTutorial')}</p>}
        <div className="pl-price" data-testid="tile-price">{t('tile.price', { price: usd(pack.price, locale) })}</div>
        <OddsBar odds={pack.odds} locale={locale} compact />
        {demo && preview.length > 0 && (
          <div className="pl-preview" data-testid="pool-preview" aria-label={t('pool.title')}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
            {preview.map((c) => <img key={c.id} src={c.imageUrl!} alt={c.name} loading="lazy" decoding="async" />)}
            <span>{t('tile.left', { remaining: pack.pool.remaining, total: pack.pool.total })}</span>
          </div>
        )}
        {!demo && (
          <p className="pl-meta">
            <span>{t('list.seller', { address: shortAddress(pack.operator.wallet) })}</span>
            <span data-testid="tile-record">{recordLine(pack, t)}</span>
            <span>{t('tile.left', { remaining: pack.pool.remaining, total: pack.pool.total })}</span>
          </p>
        )}
        <Link href={`/packs/${pack.id}`} className={`hpx-btn pl-cta${demo ? '' : ' hpx-btn--ghost'}`} data-testid={demo ? 'demo-pack-open' : 'pack-open'}>{t(demo ? 'list.demoOpen' : 'tile.view')}</Link>
      </div>
    </article>
  );
}
