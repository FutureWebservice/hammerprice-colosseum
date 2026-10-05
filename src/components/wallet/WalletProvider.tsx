'use client';

import { useEffect, useState, type ComponentType, type FC, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { WalletNotConnectedError } from '@solana/wallet-adapter-base';
import { normalizeCluster, rpcEndpoint } from '@/lib/auth/config';
import { ensureWalletHost, ensureWalletHostWhenIdle, liveWallet, registerWalletStarter } from './walletLoad';

// Wallet adapter styles: a local copy without the Google Fonts import (src/styles/wallet-adapter.css)
import '@/styles/wallet-adapter.css';

interface SolanaWalletProviderProps {
  children: ReactNode;
}

// The cluster comes from NEXT_PUBLIC_SOLANA_NETWORK (devnet unless it says mainnet-beta), and so does the
// endpoint: the configured public URL when it is one clean https URL, else the cluster's public RPC. No key
// ever reaches the browser. Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them.
const endpoint = rpcEndpoint(normalizeCluster(process.env.NEXT_PUBLIC_SOLANA_NETWORK), process.env.NEXT_PUBLIC_SOLANA_RPC_PUBLIC);

/**
 * The wallet context for the whole tree, with the adapter itself loaded late (walletLoad.ts says why). The context element is always the same one, so
 * nothing below it ever remounts when the adapter arrives; only the value changes from "no wallet" to the adapter's state.
 */
const NO_WALLET: WalletContextState = {
  autoConnect: false,
  wallets: [],
  wallet: null,
  publicKey: null,
  connecting: false,
  connected: false,
  disconnecting: false,
  select: (name) => { void ensureWalletHost().then(() => liveWallet()?.select(name)); },
  connect: async () => { await ensureWalletHost(); await liveWallet()?.connect(); },
  disconnect: async () => {},
  sendTransaction: async () => { throw new WalletNotConnectedError(); },
  signTransaction: undefined,
  signAllTransactions: undefined,
  signMessage: undefined,
  signIn: undefined,
};

/** Pages that are about a wallet load the adapter at once. Locale-prefixed paths: /en/room/..., /de/sell, /en/ai. */
const WALLET_PAGES = /^\/(?:[a-z]{2}\/)?(?:room|sell|account|packs|ai)(?:\/|$)/;

/** The adapter's autoConnect reads this key: a wallet connected before has to be reconnected on any page. */
function connectedBefore(): boolean {
  try { return !!window.localStorage.getItem('walletName'); } catch { return false; }
}

export const SolanaWalletProvider: FC<SolanaWalletProviderProps> = ({ children }) => {
  const pathname = usePathname() || '';
  const [host, setHost] = useState<{ Host: ComponentType<{ endpoint: string; onContext: (ctx: WalletContextState) => void }> } | null>(null);
  const [live, setLive] = useState<WalletContextState | null>(null);

  // Mount the lazy host; asked for once, whoever asks first.
  useEffect(() => {
    let asked = false;
    const load = () => {
      if (asked) return;
      asked = true;
      void import('./WalletHost').then((m) => setHost({ Host: m.default }));
    };
    return registerWalletStarter(load);
  }, []);

  useEffect(() => {
    if (WALLET_PAGES.test(pathname) || connectedBefore()) { void ensureWalletHost(); return undefined; }
    // Anyone else: at the first click or key press (quietly, so a scroll-driven hero is not interrupted).
    const onFirst = () => ensureWalletHostWhenIdle();
    document.addEventListener('pointerdown', onFirst, { once: true, passive: true });
    document.addEventListener('keydown', onFirst, { once: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onFirst);
      document.removeEventListener('keydown', onFirst);
    };
  }, [pathname]);

  return (
    <WalletContext.Provider value={live ?? NO_WALLET}>
      {children}
      {host && <host.Host endpoint={endpoint} onContext={setLive} />}
    </WalletContext.Provider>
  );
};
