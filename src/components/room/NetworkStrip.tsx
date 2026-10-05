'use client';

/**
 * The network line of a room that settles with a wallet: "Solana devnet", with a Details disclosure that holds the steps for a
 * wallet that is on the wrong network and the test USDC link. It says which network a signature goes to and nothing else
 * (the demonstration notice is the footer line). Renders nothing on mainnet and in a room that does not settle.
 */
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { NETWORK_MODE } from '@/legal/config';
import './room.css';

export default function NetworkStrip({ locale, wallet = false }: { locale: string; /** The room settles with a wallet (not the practice room): only then is there a network to name. */ wallet?: boolean }) {
  const t = useTranslations('room');
  if (NETWORK_MODE === 'mainnet' || !wallet) return null;
  return (
    <aside className="hp-devnet" aria-label={t('devnet.title')} data-testid="network-strip">
      <details className="hp-devnet-help">
        <summary data-testid="network-details-toggle"><strong>{t('devnet.title')}</strong><span className="hp-devnet-more">{t('devnet.details')}</span></summary>
        <div className="hp-devnet-body" data-testid="network-details">
          <p className="hp-devnet-q">{t('devnet.body')}</p>
          <h3 className="hp-sheet-sub">{t('devnet.help')}</h3>
          <ol>
            <li>{t('devnet.step1')}</li>
            <li>{t('devnet.step2')}</li>
            <li>{t('devnet.step3')}</li>
          </ol>
          <Link href={`/${locale}/account#funds`} className="hp-devnet-link">{t('devnet.funds')}</Link>
        </div>
      </details>
    </aside>
  );
}
