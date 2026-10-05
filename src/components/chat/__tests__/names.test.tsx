/** Display names in the room chat: the chosen name first, the bidder number after it; the number alone without a name; the house as the house. */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enChat from '@/locales/en/chat.json';
import deChat from '@/locales/de/chat.json';
import type { ChatMessage } from '@/contracts';

vi.mock('../ReportDialog', () => ({ default: () => null }));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import ChatPanel from '../ChatPanel';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: crypto.randomUUID(), seq: 1, at: '2026-10-05T18:00:00.000Z', paddle: 7, name: null, role: 'bidder', source: 'user', lotNumber: null, body: 'Nice card', ...over,
});
const panel = (messages: ChatMessage[], locale: 'en' | 'de' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{ chat: locale === 'en' ? enChat : deChat }} timeZone="UTC">
      <ChatPanel showId="s" locale={locale} messages={messages} mine={[]} signedIn hasPaddle operator={false} currentLotNumber={null} send={async () => {}} />
    </NextIntlClientProvider>,
  );
const who = (m: string): string[] => [...m.matchAll(/<b class="hc-who">([^<]*)<\/b>/g)].map((x) => x[1]);

describe('chat author labels', () => {
  it('a chosen name comes first, then the bidder number; no name shows the number alone', () => {
    expect(who(panel([msg({ name: 'Anna' }), msg({ paddle: 3, name: null })]))).toEqual(['Anna, Bidder 7', 'Bidder 3']);
  });
  it('the seller and the house keep their role labels; a seller who set a name is named too, the house never is', () => {
    expect(who(panel([msg({ role: 'seller', paddle: null, name: 'Anna Cards' }), msg({ role: 'seller', paddle: null }), msg({ role: 'house', paddle: null, name: null })]))).toEqual(['Anna Cards, Seller', 'Seller', 'House']);
  });
  it('speaks German', () => {
    expect(who(panel([msg({ name: 'Anna' })], 'de'))).toEqual(['Anna, Bieter 7']);
  });
  it('renders a name as text, never as markup', () => {
    const m = panel([msg({ name: 'Anna &amp; <b>x</b>' })]);
    expect(m).not.toContain('<b>x</b>');
    expect(m).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
