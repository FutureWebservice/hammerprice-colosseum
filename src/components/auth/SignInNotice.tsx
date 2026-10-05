'use client';

/**
 * The one place a failed sign-in is explained, on every page (sell, account, packs, AI, header): the same cause reads the same everywhere, with a retry
 * button and, on a phone outside the Phantom app, the hint that the Phantom in-app browser is the reliable way. Texts: account.session.auth (the page
 * chrome namespace, so every route has it).
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSession } from './SessionProvider';

/** The message key (under account.session.auth) for a sign-in error code. Server codes without a text of their own read as the generic failure. */
export function noticeKey(code: string): 'rejected' | 'noSign' | 'notConnected' | 'timeout' | 'network' | 'banned' | 'failed' {
  switch (code) {
    case 'banned': return 'banned'; // 403 from verify and /api/me: trying again cannot help, so it must not read as a hiccup
    case 'wallet_rejected': return 'rejected';
    case 'no_sign_message': return 'noSign';
    case 'not_connected': return 'notConnected';
    case 'timeout': return 'timeout';
    case 'network': return 'network';
    default: return 'failed';
  }
}

/** Causes where opening the page inside the Phantom app is worth suggesting. */
const HINT_KEYS: ReadonlySet<string> = new Set(['noSign', 'failed', 'notConnected']);

/** A phone browser that is not the Phantom app's own (which has the wallet built in). Reads the browser, so call it after mount. */
export function onMobileOutsidePhantom(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const w = window as unknown as { phantom?: { solana?: { isPhantom?: boolean } } };
  return mobile && !/Phantom/i.test(ua) && !w.phantom?.solana?.isPhantom;
}

/** Phantom's documented browse link: opens the page in the app's browser (or the store when the app is missing). */
export const phantomBrowseUrl = (pageUrl: string, origin: string): string => `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;

/** The Phantom browse link on a phone outside the Phantom app, else null. Known only in the browser (after mount), so server markup never has it. */
function usePhantomUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(onMobileOutsidePhantom() ? phantomBrowseUrl(window.location.href, window.location.origin) : null);
  }, []);
  return url;
}

export interface NoticeViewProps {
  code: string;
  onRetry: () => void;
  busy?: boolean;
  /** Smaller, for the header: the sentence only. */
  compact?: boolean;
  /** Overrides the detected Phantom link (tests). */
  phantomUrl?: string | null;
}

/** The same markup for the same code, whichever page renders it. */
export function SignInNoticeView({ code, onRetry, busy = false, compact = false, phantomUrl: forced }: NoticeViewProps) {
  const t = useTranslations('account.session.auth');
  const detected = usePhantomUrl();
  const phantomUrl = forced !== undefined ? forced : detected;
  const key = noticeKey(code);
  return (
    <div role="alert" aria-live="polite" className={compact ? 'text-xs text-red-300' : 'mt-3 text-sm text-red-300'} data-testid="signin-notice" data-code={code}>
      <p data-testid="signin-notice-text">{t(key)}</p>
      {!compact && phantomUrl && HINT_KEYS.has(key) && (
        <p className="mt-2 text-white/70" data-testid="signin-notice-hint">
          {t('phantomHint')}{' '}
          <a className="underline" href={phantomUrl} data-testid="signin-notice-phantom">{t('phantomOpen')}</a>
        </p>
      )}
      {!compact && key !== 'noSign' && key !== 'banned' && (
        <button type="button" onClick={onRetry} disabled={busy} className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4 disabled:opacity-60" data-testid="signin-retry">{t('retry')}</button>
      )}
    </div>
  );
}

/** Renders the current sign-in error of the session, or nothing. */
export default function SignInNotice({ compact = false }: { compact?: boolean }) {
  const { error, signIn, status } = useSession();
  if (!error) return null;
  return <SignInNoticeView code={error.code} onRetry={() => void signIn()} busy={status === 'signing-in'} compact={compact} />;
}
