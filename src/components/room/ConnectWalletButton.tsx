'use client';

/**
 * Connect button for pages outside the room (header, sell, account). Before a wallet is connected it opens the room's
 * wallet sheet, which says what a bidder needs and links Phantom, Solflare and Backpack. The adapter's own modal
 * is English only and, with no wallet installed, shows a bare icon and no way forward. The wallet picked there goes straight on into the
 * sign-in signature (SessionProvider). Once connected, the adapter's button (address, copy, disconnect) takes over.
 */
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useWallet } from '@solana/wallet-adapter-react';
import WalletSheet from './WalletSheet';
import { ensureWalletHost, wantSignIn } from '@/components/wallet/walletLoad';
import './room.css';

// The adapter's own button (address, copy, change, disconnect) with the picker modal it opens: one lazy chunk, only for a connected wallet.
const WalletMultiButton = dynamic(() => import('@/components/wallet/MultiButton'), { ssr: false });

export default function ConnectWalletButton() {
  const t = useTranslations('nav');
  const { connected, connecting } = useWallet();
  const [open, setOpen] = useState(false);
  if (connected) return <WalletMultiButton />;
  return (
    <>
      {/* The wallet code is fetched on the first touch of this button, so the sheet finds the wallets the page can see. */}
      <button type="button" className="wallet-adapter-button" disabled={connecting} onPointerEnter={() => void ensureWalletHost()} onFocus={() => void ensureWalletHost()} onClick={() => { void ensureWalletHost().then(() => setOpen(true)); }} data-testid="connect-wallet">
        {t('connectWallet')}
      </button>
      {open && <div className="hp-sheet-scope"><WalletSheet title={t('connectTitle')} onClose={() => setOpen(false)} onPick={wantSignIn} /></div>}
    </>
  );
}
