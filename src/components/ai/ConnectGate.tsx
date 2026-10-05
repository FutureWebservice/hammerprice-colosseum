'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { useSession, useSignIn } from '@/components/auth/SessionProvider';
import SignInNotice from '@/components/auth/SignInNotice';
import './agent.css';

/**
 * "Connect your wallet to use the AI". Every AI function needs a signed-in wallet (the routes answer 401 otherwise), so a visitor without one sees
 * this instead of the composer. The button is the existing flow: it opens the wallet picker when no wallet is connected, then asks the wallet to
 * sign in (SessionProvider.signIn). `onStart` lets the chat move focus to the composer once the sign-in worked.
 */
export default function ConnectGate({ onStart }: { onStart?: () => void }) {
  const t = useTranslations('ai');
  const { status } = useSession();
  const { signIn, pending, connected } = useSignIn();
  const id = useId();
  const loading = status === 'loading';
  const label = loading ? t('gate.loading') : pending ? t('gate.signingIn') : connected ? t('gate.signIn') : t('gate.connect');
  return (
    <section className="agc-gate" aria-labelledby={`${id}-t`} aria-busy={loading || pending} data-testid="ai-gate">
      <div className="agc-gate-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a1 1 0 0 1 1 1v2" /><path d="M3 7.5V17a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" /><path d="M20 8.5h-4a2.5 2.5 0 0 0 0 5h4z" /></svg>
      </div>
      <div className="agc-gate-text">
        <div className="agc-gate-title" id={`${id}-t`}>{t('gate.title')}</div>
        <div className="agc-gate-body">{t('gate.body')}</div>
      </div>
      <button type="button" className="ai-btn ai-btn--primary agc-gate-btn" disabled={loading || pending} onClick={() => { onStart?.(); void signIn(); }} data-testid="ai-gate-connect">{label}</button>
      <SignInNotice />
    </section>
  );
}
