'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { mintTestCard, type ApiFail } from './api';
import { formatWait } from './datetime';
import { txUrl } from './chain-links';

type Mint = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; name: string; signature: string } | { kind: 'fail'; error: ApiFail };

/** Devnet only: one button that mints a free replica card to the signed-in wallet. The server limits it (3 per day per wallet). */
export default function MintCard({ onMinted }: { onMinted: () => void }) {
  const t = useTranslations('sell');
  const locale = useLocale();
  const [m, setM] = useState<Mint>({ kind: 'idle' });

  async function mint() {
    setM({ kind: 'busy' });
    const r = await mintTestCard();
    if (r.ok) {
      setM({ kind: 'done', name: r.data.name, signature: r.data.signature });
      onMinted();
    } else setM({ kind: 'fail', error: r });
  }

  return (
    <section className="sl-mint" data-testid="mint-section">
      <h3 className="sl-h3">{t('mint.title')}</h3>
      <p className="sl-note">{t('mint.body')}</p>
      <button type="button" className="sl-btn" data-testid="mint-card" disabled={m.kind === 'busy'} onClick={mint}>
        {m.kind === 'busy' ? t('mint.busy') : t('mint.button')}
      </button>
      <div role="status" aria-live="polite" data-testid="mint-status">
        {m.kind === 'done' && (
          <p className="sl-ok">
            {t('mint.done', { name: m.name })}{' '}
            <a href={txUrl(m.signature)} target="_blank" rel="noopener noreferrer">{t('mint.receipt')}</a>
          </p>
        )}
        {m.kind === 'fail' && (
          <p className="sl-warn" data-testid="mint-error" data-code={m.error.code}>
            {m.error.code === 'rate_limited'
              ? t('mint.rateLimited', { wait: m.error.retryAfterS ? formatWait(m.error.retryAfterS, locale) : t('mint.later') })
              : m.error.code === 'mint_paused'
                ? t('mint.paused')
                : m.error.code === 'not_found'
                  ? t('mint.notHere')
                  : t('mint.failed')}
          </p>
        )}
      </div>
    </section>
  );
}
