'use client';

/**
 * The way in for an operator: what offering a pack means in plain words, and the REAL state of who may do it (from GET /api/packs/operator, the same allowlist logic
 * as the create route, so the page never promises what the API refuses). `OfferPackExplainer` sits on /packs and /packs/manage; `OfferPackCta` is the small
 * panel on /sell that leads to it.
 */
import { useEffect, useState } from 'react';
import type { PackOperatorAccess } from '@/contracts';
import { useSession } from '@/components/auth/SessionProvider';
import { Link } from '@/lib/i18n';
import { operatorAccess } from './api';
import { usePackT } from './usePackT';
import './packs-list.css';

export type AccessState = { kind: 'loading' } | { kind: 'ready'; access: PackOperatorAccess } | { kind: 'unknown' };

/** Who may offer a pack here; read again when the visitor signs in or out (the answer is per wallet). */
export function useOperatorAccess(): AccessState {
  const { status } = useSession();
  const [state, setState] = useState<AccessState>({ kind: 'loading' });
  useEffect(() => {
    let stopped = false;
    void operatorAccess().then((r) => { if (!stopped) setState(r.ok ? { kind: 'ready', access: r.data } : { kind: 'unknown' }); });
    return () => { stopped = true; };
  }, [status]);
  return state;
}

/** The sentence about availability, from the real state: open, invited (listed or not yet), closed, not signed in. */
export function accessKey(s: AccessState): { key: string; allowed: boolean | null } {
  if (s.kind === 'loading') return { key: 'offer.access.loading', allowed: null };
  if (s.kind === 'unknown') return { key: 'offer.access.unknown', allowed: null };
  const { mode, allowed } = s.access;
  if (mode === 'closed') return { key: 'offer.access.closed', allowed: allowed ?? false };
  if (allowed === null) return { key: mode === 'open' ? 'offer.access.open' : 'offer.access.invited', allowed: null };
  if (mode === 'open') return { key: 'offer.access.openYes', allowed };
  return { key: allowed ? 'offer.access.invitedYes' : 'offer.access.invitedNo', allowed };
}

/** The explainer is the one home of the pack details (the landing page only links to #odds, #build and #delivery): build the pack, the odds, then payment and delivery. */
export const BUILD_STEPS = ['cards', 'tiers', 'public', 'value'] as const;
export const DELIVERY_STEPS = ['pay', 'deliver', 'record', 'custody', 'adults'] as const;
const ODDS = ['p1', 'p2', 'p3'] as const;

export function OfferPackExplainer({ cta = true }: { cta?: boolean }) {
  const t = usePackT();
  const access = accessKey(useOperatorAccess());
  return (
    <section className="pk-offer hpx-panel" id="how" aria-labelledby="offer-title" data-testid="offer-explainer">
      <p className="hp-kicker">{t('offer.kicker')}</p>
      <h2 id="offer-title">{t('offer.title')}</h2>
      <p className="pk-offer-lede">{t('offer.lede')}</p>
      <h3 id="build" className="pk-offer-h">{t('offer.sections.build')}</h3>
      <ol className="pk-offer-list" data-testid="offer-steps">
        {BUILD_STEPS.map((k) => <li key={k}>{t(`offer.steps.${k}`)}</li>)}
      </ol>
      <h3 id="odds" className="pk-offer-h">{t('offer.sections.odds')}</h3>
      <div className="pk-offer-odds" data-testid="offer-odds">
        {ODDS.map((k) => <p key={k}>{t(`offer.odds.${k}`)}</p>)}
        <p className="pk-offer-ex">{t('offer.odds.example')}</p>
      </div>
      <h3 id="delivery" className="pk-offer-h">{t('offer.sections.delivery')}</h3>
      <ol className="pk-offer-list pk-offer-list--cont" start={BUILD_STEPS.length + 1} data-testid="offer-steps-delivery">
        {DELIVERY_STEPS.map((k) => <li key={k}>{t(`offer.steps.${k}`)}</li>)}
      </ol>
      <p className="pk-offer-access" data-testid="offer-access" data-state={access.allowed === null ? 'unknown' : access.allowed ? 'yes' : 'no'} role="status">{t(access.key)}</p>
      {cta && (
        <p className="pk-offer-actions">
          <Link href="/packs/manage" className="hpx-btn" data-testid="offer-cta">{t('list.offer')}</Link>
        </p>
      )}
    </section>
  );
}

/** On /sell: packs are a second way to sell, with the entry point right next to "new show". */
export function OfferPackCta() {
  const t = usePackT();
  return (
    <section className="pk-sellcta hpx-panel" aria-labelledby="sell-offer-title" data-testid="sell-offer-pack">
      <h2 id="sell-offer-title">{t('offer.sellTitle')}</h2>
      <p>{t('offer.sellBody')}</p>
      <p className="pk-offer-actions">
        <Link href="/packs/manage" className="hpx-btn" data-testid="sell-offer-cta">{t('list.offer')}</Link>
        <Link href="/packs#how" className="hpx-btn hpx-btn--ghost" data-testid="sell-offer-how">{t('list.how')}</Link>
      </p>
    </section>
  );
}
