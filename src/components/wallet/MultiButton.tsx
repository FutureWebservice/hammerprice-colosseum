'use client';

import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';

/** The adapter's connected-wallet button needs the modal context its "change wallet" entry opens, so it brings its own. */
export default function MultiButton() {
  return (
    <WalletModalProvider>
      <WalletMultiButton />
    </WalletModalProvider>
  );
}
