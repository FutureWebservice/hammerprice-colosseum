'use client';

/**
 * The no-wallet dead end, fixed (UX-AUDIT P0). Lists Phantom, Solflare and Backpack with install links, says in
 * two lines what a bidder needs, gives phone users the link that opens this page inside their wallet's own
 * browser, and (practice room only) offers a guest paddle that needs no wallet at all.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import { useDialog } from '@/hooks/room/useDialog';
import { isMobileUa, mobileLinks, walletRows } from './wallets';
import { autoConnectStep } from './walletConnect';
import { ensureWalletHost, wantSignIn } from '@/components/wallet/walletLoad';
import './room.css';

/**
 * The wallet choice: what a bidder needs, the wallets found on this device, the phone route. Shared by the wallet sheet and the Get ready sheet.
 * `onPick` runs on the click on a wallet: the place that wants the wallet signed in right after connecting says so there.
 */
export function WalletPicker({ onConnected, onPick, withNeeds = true }: { onConnected?: () => void; onPick?: () => void; withNeeds?: boolean }) {
  const t = useTranslations('room');
  const { wallets, wallet, select, connect, connected, connecting } = useWallet();
  const [picked, setPicked] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // one per click on a wallet button
  const used = useRef(0); // the attempt that already had its one connect(): a rejected popup must not be followed by another one
  const [phone, setPhone] = useState<ReturnType<typeof mobileLinks> | null>(null);

  useEffect(() => { void ensureWalletHost(); }, []); // the wallets listed below come from the adapter

  useEffect(() => {
    if (isMobileUa(navigator.userAgent)) setPhone(mobileLinks(window.location.href, window.location.origin));
  }, []);

  useEffect(() => { if (connected) onConnected?.(); }, [connected, onConnected]);

  // Selecting is enough when the provider auto-connects; this covers a provider that does not.
  // One click is one attempt (K15): after the person rejects the popup, `connecting` falls back to false and this effect runs again,
  // but the attempt is used up, so Phantom is not asked a second time until the next click.
  useEffect(() => {
    const step = autoConnectStep({ picked, selected: wallet?.adapter.name ?? null, connected, connecting, attempt, used: used.current });
    if (step === 'wait') return;
    used.current = attempt;
    if (step === 'connect') void connect().catch(() => undefined);
  }, [picked, wallet, connected, connecting, connect, attempt]);

  const rows = walletRows(wallets.map((w) => ({ name: w.adapter.name, installed: w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable })));

  return (
    <>
      {withNeeds && (
        <>
          <h3 className="hp-sheet-sub">{t('wallet.need')}</h3>
          <ul className="hp-sheet-list">
            <li>{t('wallet.needWallet')}</li>
            <li>{t('wallet.needUsdc')}</li>
          </ul>
        </>
      )}

      <h3 className="hp-sheet-sub">{rows.some((r) => r.installed) ? t('wallet.detected') : t('wallet.getWallet')}</h3>
      <ul className="hp-wallet-rows">
        {rows.map((r) => (
          <li key={r.id}>
            {r.installed ? (
              <button type="button" className="hp-wallet-row is-installed" data-testid={`wallet-connect-${r.id}`} onClick={() => { wantSignIn(false); onPick?.(); setPicked(r.name); setAttempt((n) => n + 1); select(r.name as WalletName); }}>
                {connecting && wallet?.adapter.name === r.name ? t('wallet.connecting') : t('wallet.connect', { name: r.name })}
              </button>
            ) : (
              <a className="hp-wallet-row" href={r.install ?? '#'} target="_blank" rel="noopener noreferrer">{t('wallet.install', { name: r.name })}</a>
            )}
          </li>
        ))}
      </ul>

      {phone && (
        <>
          <h3 className="hp-sheet-sub">{t('wallet.mobileTitle')}</h3>
          <p className="hp-sheet-text">{t('wallet.mobileBody')}</p>
          <ul className="hp-wallet-rows">
            {phone.map((l) => (
              <li key={l.id}><a className="hp-wallet-row" href={l.href} data-testid={`wallet-open-${l.id}`}>{t('wallet.openIn', { name: l.name })}</a></li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export default function WalletSheet({ onClose, onGuest, onPick, title }: { onClose: () => void; onGuest?: () => void; onPick?: () => void; /** Overrides the room's "connect a wallet to bid" heading on pages that are not about bidding. */ title?: string }) {
  const t = useTranslations('room');
  const ref = useDialog<HTMLDivElement>(onClose);

  return (
    <>
      <div className="hp-sheet-backdrop" onClick={onClose} />
      <div className="hp-sheet" ref={ref} role="dialog" aria-modal="true" aria-label={title ?? t('wallet.title')} data-testid="wallet-sheet">
        <div className="hp-sheet-head">
          <h2 className="hp-sheet-title">{title ?? t('wallet.title')}</h2>
          <button type="button" className="hp-sheet-close" onClick={onClose} aria-label={t('wallet.close')}>×</button>
        </div>

        <WalletPicker onConnected={onClose} onPick={onPick} />

        {onGuest && (
          <div className="hp-sheet-guest">
            <h3 className="hp-sheet-sub">{t('wallet.guestTitle')}</h3>
            <p className="hp-sheet-text">{t('wallet.guestBody')}</p>
            <button type="button" className="hp-sheet-primary" data-testid="guest-paddle" onClick={() => { onGuest(); onClose(); }}>{t('wallet.guest')}</button>
          </div>
        )}
      </div>
    </>
  );
}
