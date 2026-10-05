'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Credits } from './useAiCredits';
import BuyCredits from './BuyCredits';

/** Balance, the pack and its price (test USDC with no value on devnet, USDC on mainnet), and the buy button. */
export default function CreditsBar({ credits, onBought }: { credits: Credits; onBought: (balance: number) => void }) {
  const t = useTranslations('ai.credits');
  const [bought, setBought] = useState<{ balance: number; url?: string } | null>(null);
  const price = credits.cluster === 'devnet' ? t('packTest') : t('packReal');
  if (credits.free) return <div className="ai-credits" data-testid="ai-credits"><p className="ai-note" data-testid="ai-free">{t('freeNote')}</p></div>; // AI_FREE: no balance, no pack, no purchase
  return (
    <div className="ai-credits" data-testid="ai-credits">
      <p className="ai-bal" data-testid="ai-balance">{credits.balance === 0 ? t('none') : credits.balance === 1 ? t('balanceOne') : t('balance', { count: credits.balance })}</p>
      {!credits.configured ? (
        <p className="ai-note" data-testid="ai-nokey">{t('noKey')}</p>
      ) : credits.packsLeftToday === 0 ? (
        <p className="ai-note">{t('limitReached')}</p>
      ) : (
        <>
          <p className="ai-note" data-testid="ai-pack">{price}</p>
          <BuyCredits cluster={credits.cluster} onBought={(balance, url) => { setBought({ balance, url }); onBought(balance); }} />
        </>
      )}
      {bought && (
        <p className="ai-ok" role="status" data-testid="ai-bought">
          {t('bought', { count: bought.balance })}{' '}
          {bought.url && <a href={bought.url} target="_blank" rel="noopener noreferrer">{t('explorer')}</a>}
        </p>
      )}
    </div>
  );
}
