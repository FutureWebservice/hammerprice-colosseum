/**
 * The chat panel is never an empty dark area: every viewer state shows something useful (anonymous: connect card with its button, signed in without a bidder
 * number: get ready card, with a number: list plus input, operator: the tabs), and the skeleton fills the sidebar while the panel's code loads.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enChat from '@/locales/en/chat.json';
import deChat from '@/locales/de/chat.json';
import type { ChatMessage } from '@/contracts';

vi.mock('../ReportDialog', () => ({ default: () => null }));
vi.mock('@/components/chat/ModToast', () => ({ default: () => null }));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import ChatPanel from '../ChatPanel';
import ChatSkeleton from '../ChatSkeleton';
import { Shell } from '@/components/room/slots/SideChat';

const wrap = (node: React.ReactNode, locale: 'en' | 'de' = 'en') => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={{ chat: locale === 'en' ? enChat : deChat }} timeZone="UTC">{node}</NextIntlClientProvider>,
);
const msg: ChatMessage = { id: crypto.randomUUID(), seq: 1, at: '2026-10-05T18:00:00.000Z', paddle: 7, name: null, role: 'bidder', source: 'user', lotNumber: null, body: 'Nice card' };
const panel = (over: Partial<React.ComponentProps<typeof ChatPanel>>, locale: 'en' | 'de' = 'en') => wrap(
  <ChatPanel showId="s" locale={locale} messages={[]} mine={[]} signedIn={false} hasPaddle={false} operator={false} currentLotNumber={null} send={async () => {}} onGetReady={() => {}} {...over} />, locale);
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('chat panel states are never empty', () => {
  it('anonymous: the "Connect your wallet to chat" card with the connect button, no input', () => {
    const h = panel({});
    expect(h).toContain('data-testid="chat-cannot-write"');
    expect(h).toContain('data-state="wallet"');
    expect(text(h)).toContain('Connect your wallet to chat');
    expect(h).toMatch(/data-testid="chat-get-ready"[^>]*>Connect wallet</);
    expect(h).not.toContain('chat-input');
    expect(text(h).length).toBeGreaterThan(80);
  });
  it('signed in without a bidder number: "Get ready to bid to chat" with its button, no input', () => {
    const h = panel({ signedIn: true });
    expect(h).toContain('data-state="paddle"');
    expect(text(h)).toContain('Get ready to bid to chat');
    expect(text(h)).toMatch(/bidder number/i);
    expect(h).toMatch(/data-testid="chat-get-ready"[^>]*>Get ready to bid</);
    expect(h).not.toContain('chat-input');
  });
  it('with a bidder number: the messages and the input, no gate card', () => {
    const h = panel({ signedIn: true, hasPaddle: true, messages: [msg] });
    expect(h).toContain('Nice card');
    expect(h).toContain('data-testid="chat-input"');
    expect(h).not.toContain('chat-cannot-write');
  });
  it('operator without a bidder number can write too', () => {
    expect(panel({ signedIn: true, operator: true })).toContain('data-testid="chat-input"');
  });
  it('a room with no message yet still says so', () => {
    expect(text(panel({ signedIn: true, hasPaddle: true }))).toContain('No messages yet');
  });
  it('German gate cards', () => {
    expect(text(panel({}, 'de'))).toContain('Verbinden Sie Ihre Wallet, um zu chatten');
    expect(text(panel({ signedIn: true }, 'de'))).toContain('Machen Sie sich bereit zum Bieten, um zu chatten');
  });
  it('the skeleton has bars and a label', () => {
    const h = wrap(<ChatSkeleton />);
    expect(h).toContain('data-testid="chat-skeleton"');
    expect(h.match(/hc-skel-bar/g)!.length).toBeGreaterThanOrEqual(3);
    expect(h).toContain('aria-label="Loading the chat"');
  });
});

describe('the Chat button for a visitor who is not signed in', () => {
  const chat = { messages: [], mine: [], signedIn: false, operator: false, queue: null, unread: 0, announce: null, enabled: true, send: async () => {}, refresh: () => {}, refreshQueue: () => {}, markRead: () => {} };
  const closed = (locale: 'en' | 'de') => wrap(
    <Shell chat={chat as never} showId="s" locale={locale} currentLotNumber={null} hasPaddle={false} open={false} setOpen={() => {}} tab="chat" setTab={() => {}} filter="pending" setFilter={() => {}} focusId={null} setFocusId={() => {}} />, locale);
  it.each(['en', 'de'] as const)('is shown (%s) with no panel yet; the panel opened by it carries the connect card (tested above)', (l) => {
    const h = closed(l);
    expect(h).toContain('data-testid="chat-launcher"');
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('data-testid="chat-panel"');
  });
});

describe('the open sidebar', () => {
  const chat = { messages: [], mine: [], signedIn: false, operator: false, queue: null, unread: 0, announce: null, enabled: true, send: async () => {}, refresh: () => {}, refreshQueue: () => {}, markRead: () => {} };
  const shell = (over: Record<string, unknown>) => wrap(
    <Shell chat={{ ...chat, ...over } as never} showId="s" locale="en" currentLotNumber={null} hasPaddle={false} open setOpen={() => {}} tab="chat" setTab={() => {}} filter="pending" setFilter={() => {}} focusId={null} setFocusId={() => {}} />,
  );
  it('has a header and content (the skeleton until the panel code is there) for a visitor', () => {
    const h = shell({});
    expect(h).toContain('data-testid="chat-panel"');
    expect(text(h)).toContain('Room chat');
    expect(h).toMatch(/chat-skeleton|chat-cannot-write/);
  });
  it('the operator gets the Chat and Moderation tabs', () => {
    const h = shell({ operator: true, signedIn: true });
    expect(h).toContain('data-testid="chat-tab-mod"');
    expect(text(h)).toContain('Chat');
  });
});
