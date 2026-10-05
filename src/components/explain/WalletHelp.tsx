/**
 * "Need a wallet?": the help path for someone who has never bid with a Solana wallet. Used on the
 * landing page and the FAQ, and exported so a room can show the same block. Three install links
 * (Phantom, Solflare, Backpack), the devnet switch, the free test USDC, and the phone note.
 *
 * Server component over plain JSON (explain.json `walletHelp`), so it works with no wallet, no
 * provider and no client state.
 */
import Link from 'next/link';
import type { Locale } from '@/lib/i18n/config';
import { WALLET_LINKS } from '@/components/landing/site';
import { getExplainMessages } from './content';
import './explain.css';

export default function WalletHelp({ locale, as: H = 'h2' }: { locale: Locale; as?: 'h2' | 'h3' }) {
  const w = getExplainMessages(locale).walletHelp;
  return (
    <section className="ex-wallet" id={w.id} aria-labelledby="ex-wallet-heading">
      <H id="ex-wallet-heading">{w.heading}</H>
      <p className="ex-wallet-lede">{w.lede}</p>
      <ol className="ex-wallet-steps">
        {w.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <ul className="ex-wallet-links">
        {WALLET_LINKS.map((l) => (
          <li key={l.id}>
            <a href={l.href} target="_blank" rel="noopener noreferrer" className="ex-wallet-link">
              {w.installLabel} {l.name}
            </a>
          </li>
        ))}
      </ul>
      <p className="ex-wallet-mobile">{w.mobile}</p>
      <p className="ex-wallet-more">
        <Link href={`/${locale}/about#faq`}>{w.faqLink}</Link>
      </p>
    </section>
  );
}
