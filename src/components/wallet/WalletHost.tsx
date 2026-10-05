'use client';

/**
 * The lazy half of the wallet (see walletLoad.ts): the real wallet-adapter providers, loaded as one chunk. It renders no page content. A bridge inside
 * the adapter's context hands every state change to the always-loaded provider (WalletProvider.tsx), which republishes it to the whole tree under the
 * adapter's own WalletContext, so every `useWallet()` in the app reads the real thing once this has mounted. The adapter's picker modal is mounted here too.
 */
import { memo, useEffect, useLayoutEffect } from 'react';
import { ConnectionProvider, WalletProvider, useWallet, type WalletContextState } from '@solana/wallet-adapter-react';
import { WalletModalProvider, useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { Adapter } from '@solana/wallet-adapter-base';
import { bindWalletModal, reportWalletLive } from './walletLoad';

// No explicit adapters: Phantom, Solflare and Backpack register themselves through the Wallet
// Standard, and the wallet-adapter picks them up. A fixed module-level array keeps the prop stable.
const WALLETS: Adapter[] = [];

// A declined prompt or a failed connect is the person's choice, not a fault; anything else is logged.
const onError = (error: Error) => {
  if (error.message?.includes('User rejected') || error.name === 'WalletConnectionError') return;
  console.error('Wallet error:', error);
};

function Bridge({ onContext }: { onContext: (ctx: WalletContextState) => void }) {
  const ctx = useWallet();
  const { setVisible } = useWalletModal();
  // Layout effect: the tree below the provider re-renders with the real value before the browser paints it.
  useLayoutEffect(() => {
    onContext(ctx);
    reportWalletLive(ctx);
  }, [ctx, onContext]);
  useEffect(() => bindWalletModal(() => setVisible(true)), [setVisible]);
  return null;
}

function WalletHost({ endpoint, onContext }: { endpoint: string; onContext: (ctx: WalletContextState) => void }) {
  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* autoConnect keeps the wallet connected across page reloads and navigation */}
      <WalletProvider wallets={WALLETS} autoConnect onError={onError}>
        <WalletModalProvider>
          <Bridge onContext={onContext} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default memo(WalletHost);
