'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { WalletErrorBoundary } from '@/components/wallet/WalletErrorBoundary';
import ConnectWalletButton from '@/components/room/ConnectWalletButton';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSession } from '@/components/auth/SessionProvider';
import { SignInNoticeView } from '@/components/auth/SignInNotice';
import WalletPromptHint, { markHintConfirmed } from '@/components/explain/WalletPromptHint';
import './sell.css';

export type GateKind = 'loading' | 'connect' | 'sign' | 'signing' | 'rejected' | 'failed' | 'mismatch' | 'no_sign';

/** What the visitor sees until they are signed in. Pure: the container picks the kind. */
export function GateView({ kind, onSignIn, walletButton, errorCode }: { kind: GateKind; onSignIn: () => void; walletButton: ReactNode; /** The code behind `failed` (the shared notice words it). */ errorCode?: string }) {
  const t = useTranslations('sell');
  const tt = useTranslations('tour');
  const locale = useLocale();
  if (kind === 'loading') return <p className="sl-note" role="status" data-testid="gate-loading">{t('gate.loading')}</p>;
  return (
    <section className="sl-gate" data-testid="sign-in-gate" data-kind={kind}>
      <h2 className="sl-h2">{kind === 'connect' ? t('gate.connectTitle') : t('gate.signTitle')}</h2>
      <p className="sl-lede">{kind === 'connect' ? t('gate.connectBody') : t('gate.signBody')}</p>
      {kind === 'mismatch' && <p className="sl-warn" role="alert">{t('gate.mismatch')}</p>}
      {(kind === 'rejected' || kind === 'failed' || kind === 'no_sign') && (
        <SignInNoticeView code={kind === 'rejected' ? 'wallet_rejected' : kind === 'no_sign' ? 'no_sign_message' : errorCode ?? 'wallet_failed'} onRetry={onSignIn} />
      )}
      {(kind === 'connect' || kind === 'sign') && <WalletPromptHint kind="signin" />}
      <div className="sl-actions">
        {kind === 'connect' && <WalletErrorBoundary>{walletButton}</WalletErrorBoundary>}
        {(kind === 'sign' || kind === 'rejected' || kind === 'failed' || kind === 'mismatch' || kind === 'signing') && (
          <button type="button" className="sl-btn sl-btn--primary" data-testid="sign-in" disabled={kind === 'signing'} onClick={onSignIn}>
            {kind === 'signing' ? t('gate.signing') : t('gate.signIn')}
          </button>
        )}
      </div>
      {kind === 'connect' && (
        <p className="sl-note" data-testid="gate-no-wallet">
          {t('gate.noWallet')}{' '}
          <a href={`/${locale}/about#wallet`}>{tt('help.wallet')}</a>
        </p>
      )}
    </section>
  );
}

/** Renders `children` only for a signed-in session; otherwise the connect or sign-in step. */
export default function SignInGate({ children }: { children: ReactNode }) {
  const s = useSession();
  const { signMessage, signIn } = useWallet();
  // A session means the wallet confirmation of the sign-in was approved: the note above that button is one quiet line from now on.
  useEffect(() => { if (s.status === 'signed-in') markHintConfirmed('signin'); }, [s.status]);
  if (s.status === 'signed-in') return <>{children}</>;

  let kind: GateKind;
  if (s.status === 'loading') kind = 'loading';
  else if (s.status === 'signing-in') kind = 'signing';
  else if (!s.connected) kind = 'connect';
  else if (!signMessage && !signIn) kind = 'no_sign';
  else if (s.error?.code === 'wallet_rejected') kind = 'rejected';
  else if (s.error) kind = 'failed';
  else kind = 'sign';

  return <GateView kind={kind} onSignIn={() => void s.signIn()} errorCode={s.error?.code} walletButton={<ConnectWalletButton />} />;
}
