'use client';

/**
 * A short note directly above a button that opens the wallet: what the wallet is about to show and whether money
 * moves. Large (title, sentence, link) until the person has confirmed once for that occasion in this session, then
 * one quiet line. It never says what a particular wallet displays, only that the wallet may add notes of its own.
 * Call markHintConfirmed(kind) when the wallet prompt for that occasion was approved.
 *
 *   signin   the sign-in message        paddle   the bidding number     pay   the payment
 *   consign  listing a card (no prompt) credits  buying AI drafts
 */
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import type { Cluster } from '@/contracts';
import { useClusterT } from '@/lib/client/cluster-text';
import { browserStore, readFlag, writeFlag } from '@/lib/client/safe-storage';
import './ux.css';

export const HINT_KINDS = ['signin', 'paddle', 'pay', 'consign', 'credits'] as const;
export type HintKind = (typeof HINT_KINDS)[number];
export const HINT_EVENT = 'hp-hint-confirmed';
export const hintKey = (k: HintKind) => `hp.hint.${k}`;

const confirmedThisPage = new Set<HintKind>(); // memory for when sessionStorage is blocked

export function isHintCompact(kind: HintKind): boolean {
  return confirmedThisPage.has(kind) || readFlag(browserStore('session'), hintKey(kind)) === '1';
}

export function markHintConfirmed(kind: HintKind): void {
  confirmedThisPage.add(kind);
  writeFlag(browserStore('session'), hintKey(kind), '1');
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(HINT_EVENT, { detail: kind }));
}

export default function WalletPromptHint({ kind, cluster }: { kind: HintKind; cluster?: Cluster }) {
  const t = useClusterT('tour', cluster);
  const locale = useLocale();
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    setCompact(isHintCompact(kind));
    const on = (e: Event) => { if ((e as CustomEvent).detail === kind) setCompact(true); };
    window.addEventListener(HINT_EVENT, on);
    return () => window.removeEventListener(HINT_EVENT, on);
  }, [kind]);

  if (compact) {
    return <p className="ux-hint ux-hint-compact" data-testid="wallet-hint" data-kind={kind} data-compact="true">{t(`hint.${kind}`)}</p>;
  }
  return (
    <aside className="ux-hint" aria-label={t('hint.title')} data-testid="wallet-hint" data-kind={kind} data-compact="false">
      <p className="ux-hint-title">{t('hint.title')}</p>
      <p className="ux-hint-text">{t(`hint.${kind}`)}</p>
      <p className="ux-hint-more">
        {kind !== 'consign' && <>{t('hint.caveat')} </>}
        <a href={`/${locale}/about#glossary`}>{t('hint.why')}</a>
      </p>
    </aside>
  );
}
