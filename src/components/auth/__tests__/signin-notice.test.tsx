/**
 * One cause, one text, on every page: the sell gate, the AI gate and the shared notice render the same words for the same sign-in error, in both
 * languages, and every page component that asks for a sign-in (packs buy panel, packs manage page, header, sell, AI) uses the shared notice.
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import deAccount from '@/locales/de/account.json';
import enAccount from '@/locales/en/account.json';
import deAi from '@/locales/de/ai.json';
import enAi from '@/locales/en/ai.json';
import deSell from '@/locales/de/sell.json';
import enSell from '@/locales/en/sell.json';
import deTour from '@/locales/de/tour.json';
import enTour from '@/locales/en/tour.json';
import deGlossary from '@/locales/de/glossary.json';
import enGlossary from '@/locales/en/glossary.json';
import deRoom from '@/locales/de/room.json';
import enRoom from '@/locales/en/room.json';
import { resetSession, session } from '@/components/ai/__tests__/session-mock';
import { roomSignInError } from '@/hooks/room/useRoomSignIn';
import { SignInError } from '@/lib/client/session';

(globalThis as { React?: unknown }).React = React;
vi.mock('@/components/auth/SessionProvider', async () => (await import('@/components/ai/__tests__/session-mock')).sessionModule());
vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>, useRouter: () => ({ push: () => {} }) }));

const { default: SignInNotice, SignInNoticeView, noticeKey, phantomBrowseUrl } = await import('../SignInNotice');
const { default: ConnectGate } = await import('@/components/ai/ConnectGate');
const { GateView } = await import('@/components/sell/SignInGate');

const M = {
  de: { account: deAccount, ai: deAi, sell: deSell, tour: deTour, glossary: deGlossary },
  en: { account: enAccount, ai: enAi, sell: enSell, tour: enTour, glossary: enGlossary },
} as const;
const render = (locale: 'de' | 'en', node: React.ReactNode) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={M[locale]} timeZone="Europe/Berlin" onError={(e) => { throw e; }} getMessageFallback={({ key }) => { throw new Error(`missing message ${key}`); }}>{node}</NextIntlClientProvider>,
);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const CASES = [
  ['wallet_rejected', 'rejected'],
  ['no_sign_message', 'noSign'],
  ['not_connected', 'notConnected'],
  ['timeout', 'timeout'],
  ['network', 'network'],
  ['banned', 'banned'],
  ['wallet_failed', 'failed'],
  ['rate_limited', 'failed'],
] as const;

beforeEach(resetSession);

describe.each(['de', 'en'] as const)('sign-in errors read the same on every page (%s)', (l) => {
  const auth = M[l].account.session.auth;

  it.each(CASES)('%s', (code, key) => {
    expect(noticeKey(code)).toBe(key);
    session.connected = true;
    session.error = { code };
    const shared = text(render(l, <SignInNotice />));
    const ai = text(render(l, <ConnectGate />));
    expect(shared).toContain(auth[key]);
    expect(ai).toContain(auth[key]);
    // The sell gate words the same cause from its own container: rejected, no_sign and failed kinds.
    const gate = (kind: 'rejected' | 'no_sign' | 'failed') => text(render(l, <GateView kind={kind} onSignIn={() => {}} walletButton={null} errorCode={code} />));
    if (code === 'wallet_rejected') expect(gate('rejected')).toContain(auth.rejected);
    else if (code === 'no_sign_message') expect(gate('no_sign')).toContain(auth.noSign);
    else expect(gate('failed')).toContain(auth[key]);
  });

  it('every message is there, and a retry button follows every cause except "cannot sign" and "suspended"', () => {
    for (const [code, key] of CASES) {
      const h = render(l, <SignInNoticeView code={code} onRetry={() => {}} phantomUrl={null} />);
      expect(h.includes('data-testid="signin-retry"'), code).toBe(key !== 'noSign' && key !== 'banned');
      expect(text(h)).toContain(auth[key]);
    }
    expect(auth.retry.length).toBeGreaterThan(0);
  });

  it('no error, no notice', () => {
    session.error = null;
    expect(render(l, <SignInNotice />)).toBe('');
  });

  it('the Phantom app browser hint shows for the causes a phone browser produces, with the documented browse link, and never in the compact header form', () => {
    const url = phantomBrowseUrl('https://hammerprice.test/en/packs?a=1', 'https://hammerprice.test');
    expect(url).toBe('https://phantom.app/ul/browse/https%3A%2F%2Fhammerprice.test%2Fen%2Fpacks%3Fa%3D1?ref=https%3A%2F%2Fhammerprice.test');
    for (const code of ['no_sign_message', 'wallet_failed', 'not_connected']) {
      const h = render(l, <SignInNoticeView code={code} onRetry={() => {}} phantomUrl={url} />);
      expect(h).toContain(`href="${url}"`);
      expect(text(h)).toContain(auth.phantomHint);
    }
    for (const code of ['wallet_rejected', 'network', 'timeout']) expect(render(l, <SignInNoticeView code={code} onRetry={() => {}} phantomUrl={url} />)).not.toContain('signin-notice-hint');
    expect(render(l, <SignInNoticeView code="no_sign_message" onRetry={() => {}} phantomUrl={url} compact />)).not.toContain('signin-notice-hint');
    expect(render(l, <SignInNoticeView code="no_sign_message" onRetry={() => {}} phantomUrl={null} />)).not.toContain('signin-notice-hint');
  });

  it('the room words the same real causes (its own texts, same meaning: only a decline says declined)', () => {
    const room = M[l] === M.de ? deRoom : enRoom;
    const t = (e: SignInError) => { const r = roomSignInError(e); return r.wallet ? (room.errors as Record<string, string>)[`wallet${r.wallet[0].toUpperCase()}${r.wallet.slice(1)}`] : (room.errors as Record<string, string>)[r.key.replace('errors.', '')]; };
    expect(t(new SignInError('not_connected'))).toBe(auth.notConnected);
    expect(t(new SignInError('timeout'))).toBe(auth.timeout);
    expect(t(new SignInError('wallet_rejected'))).toBe((room.errors as Record<string, string>).walletRejected);
    expect(t(new SignInError('wallet_failed'))).toBe((room.errors as Record<string, string>).walletUnknown);
    expect(t(new SignInError('no_sign_message'))).toBe((room.errors as Record<string, string>).noSignMessage);
  });
});

describe('every page component that asks for a sign-in shows the shared notice', () => {
  const root = path.join(__dirname, '..', '..');
  it.each(['packs/BuyPanel.tsx', 'packs/ManagePacks.tsx', 'ai/ConnectGate.tsx', 'layout/Header.tsx', 'sell/SignInGate.tsx'])('%s', (f) => {
    expect(fs.readFileSync(path.join(root, f), 'utf8')).toMatch(/SignInNotice/);
  });
  it('and none of them words a sign-in error on its own any more', () => {
    for (const f of ['ai/ConnectGate.tsx', 'sell/SignInGate.tsx']) expect(fs.readFileSync(path.join(root, f), 'utf8'), f).not.toMatch(/gate\.(rejected|failed|noSign|error)\b/);
  });
});
