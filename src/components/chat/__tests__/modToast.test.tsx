/** The operator's "message waiting" popup: what it shows, who sees it, the calls behind its buttons, and the deep link into the Moderation tab. No DOM needed. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import enChat from '@/locales/en/chat.json';
import deChat from '@/locales/de/chat.json';
import type { Queue } from '../chatClient';

vi.mock('../ReportDialog', () => ({ default: () => null }));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import ModToast, { ModToastView, type ModToastViewProps } from '../ModToast';
import ModerationView from '../ModerationView';
import { decide, deepLink, pickToast, previewText, PREVIEW_MAX, REJECT_PRESETS } from '../toastLogic';

const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type QM = Queue['messages'][number];
const qm = (n: number, over: Partial<QM> = {}): QM => ({
  id: ID(n), seq: n, at: '2026-10-05T18:00:00.000Z', status: 'pending', paddle: 7, name: null, wallet: WALLET, role: 'bidder', source: 'user', lotNumber: null,
  body: `Message ${n}`, reports: 0, reportDetails: [], reason: null, moderatedAt: null, ...over,
});
const queue = (messages: QM[], pending = messages.filter((m) => m.status === 'pending').length): Queue => ({
  messages, counts: { pending, approved: 0, rejected: 0, reported: 0 }, silenced: [], lastSeq: messages.length,
});

const tr = (locale: 'en' | 'de' = 'en'): ModToastViewProps['t'] => createTranslator({ locale, messages: { chat: locale === 'en' ? enChat : deChat }, namespace: 'chat' }) as unknown as ModToastViewProps['t'];

describe('previewText', () => {
  it('keeps short text, collapses white space and cuts long text at 80 characters', () => {
    expect(previewText('  hello \n  world ')).toBe('hello world');
    const cut = previewText('x'.repeat(200));
    expect(cut).toBe(`${'x'.repeat(PREVIEW_MAX)}...`);
    expect(Array.from(previewText('😀'.repeat(100))).length).toBe(PREVIEW_MAX + 3); // by code point, never in the middle of an emoji
  });
});

describe('pickToast', () => {
  it('nothing without a queue or without waiting messages', () => {
    expect(pickToast(null, 0)).toEqual({ newest: null, count: 0 });
    expect(pickToast(queue([qm(1, { status: 'approved' })]), 0)).toEqual({ newest: null, count: 0 });
  });
  it('the newest waiting message and a count; dismissing hides what was there, a later message shows again', () => {
    const q = queue([qm(1), qm(2), qm(3)]);
    const p = pickToast(q, 0);
    expect(p.count).toBe(3);
    expect(p.newest?.id).toBe(ID(3));
    expect(pickToast(q, 3)).toEqual({ newest: null, count: 0 });
    const later = pickToast(queue([qm(1), qm(2), qm(3), qm(4)]), 3);
    expect(later.count).toBe(1);
    expect(later.newest?.id).toBe(ID(4));
  });
  it('counts waiting messages beyond the 50 the server lists', () => {
    expect(pickToast(queue([qm(1), qm(2)], 60), 0).count).toBe(60);
  });
});

const view = (over: Partial<ModToastViewProps> = {}): ModToastViewProps => ({
  t: tr(), who: 'Bidder 7', preview: 'Nice card', count: 1, step: 'idle', busy: false, error: null,
  onApprove: vi.fn(), onRejectStart: vi.fn(), onRejectWith: vi.fn(), onBack: vi.fn(), onOpen: vi.fn(), onDismiss: vi.fn(), ...over,
});
type El = React.ReactElement<{ children?: React.ReactNode; [k: string]: unknown }>;
/** Finds an element by data-testid in the (hook-free) view's element tree. */
function find(node: React.ReactNode, id: string): El | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const c of node) { const f = find(c, id); if (f) return f; } return null; }
  const el = node as El;
  if (el.props?.['data-testid'] === id) return el;
  return find(el.props?.children, id);
}
const click = (props: ModToastViewProps, id: string) => (find(ModToastView(props), id)!.props.onClick as () => void)();

describe('the popup', () => {
  it('renders as plain text with the bidder number, an accessible name and no wallet', () => {
    const html = renderToStaticMarkup(<ModToastView {...view({ preview: '<b>hi</b> & <script>x</script>' })} />);
    expect(html).toContain('Bidder 7');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(WALLET);
    expect(html).toContain('1 message waiting');
    expect(html).toContain('aria-label="A message is waiting for your approval"');
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
    expect(html).toContain('Open chat');
    expect(html).not.toContain('Newest message');
  });
  it('shows a count and says the preview is the newest when several wait', () => {
    const html = renderToStaticMarkup(<ModToastView {...view({ count: 3 })} />);
    expect(html).toContain('3 messages waiting');
    expect(html).toContain('Newest message:');
  });
  it('speaks German in the Sie-form', () => {
    const html = renderToStaticMarkup(<ModToastView {...view({ t: tr('de'), count: 2 })} />);
    expect(html).toContain('2 Nachrichten warten');
    expect(html).toContain('Freigeben');
    expect(html).toContain('Chat öffnen');
    expect(html).toContain('Ihre Freigabe');
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });
  it('its buttons call approve, reject, open and dismiss', () => {
    const v = view();
    click(v, 'mod-toast-approve');
    click(v, 'mod-toast-reject');
    click(v, 'mod-toast-open');
    click(v, 'mod-toast-dismiss');
    expect(v.onApprove).toHaveBeenCalledTimes(1);
    expect(v.onRejectStart).toHaveBeenCalledTimes(1);
    expect(v.onOpen).toHaveBeenCalledTimes(1);
    expect(v.onDismiss).toHaveBeenCalledTimes(1);
  });
  it('Escape dismisses it (keyboard)', () => {
    const v = view();
    (ModToastView(v).props.onKeyDown as (e: { key: string }) => void)({ key: 'Escape' });
    (ModToastView(v).props.onKeyDown as (e: { key: string }) => void)({ key: 'Enter' });
    expect(v.onDismiss).toHaveBeenCalledTimes(1);
  });
  it('Reject offers the fixed reasons and a way back', () => {
    const v = view({ step: 'reject' });
    const html = renderToStaticMarkup(<ModToastView {...v} />);
    for (const p of REJECT_PRESETS) expect(html).toContain(`data-testid="mod-toast-reason-${p}"`);
    expect(html).not.toContain('data-testid="mod-toast-approve"');
    click(v, 'mod-toast-reason-rude');
    click(v, 'mod-toast-back');
    expect(v.onRejectWith).toHaveBeenCalledWith('rude');
    expect(v.onBack).toHaveBeenCalledTimes(1);
  });
});

describe('who sees it', () => {
  const html = (operator: boolean, enabled = true) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{ chat: enChat }}>
        <ModToast showId={SHOW} operator={operator} enabled={enabled} paused={false} onOpen={() => {}} onChanged={() => {}} />
      </NextIntlClientProvider>,
    );
  it('nothing at all for anyone who is not the operator, or while the chat is off', () => {
    expect(html(false)).toBe('');
    expect(html(true, false)).toBe('');
  });
  it('the operator gets an (empty until a message waits) polite live region', () => {
    const h = html(true);
    expect(h).toContain('role="status"');
    expect(h).toContain('aria-live="polite"');
    expect(h).not.toContain('data-testid="mod-toast"');
  });
});

describe('the calls behind the buttons (the existing moderate endpoint)', () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch = (status = 200, payload: unknown = { ok: true, affected: 1 }) => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(payload), { status });
    }));
  };
  afterEach(() => vi.unstubAllGlobals());
  const reasonOf = (p: string) => tr()(`mod.reasons.${p as 'rude'}`);

  it('Approve posts action approve for exactly that message', async () => {
    fakeFetch();
    expect(await decide(SHOW, { kind: 'approve', id: ID(3) }, reasonOf)).toEqual({ ok: true });
    expect(calls).toEqual([{ url: `/api/shows/${SHOW}/chat/moderate`, body: { action: 'approve', messageIds: [ID(3)] } }]);
  });
  it('Reject posts the chosen fixed reason as a sentence the author sees', async () => {
    fakeFetch();
    expect(await decide(SHOW, { kind: 'reject', id: ID(3), preset: 'rude' }, reasonOf)).toEqual({ ok: true });
    expect(calls[0].body).toEqual({ action: 'reject', messageIds: [ID(3)], reason: 'Please stay polite.' });
  });
  it('a refusal comes back as a translation key, never throws', async () => {
    fakeFetch(403, { ok: false, code: 'not_seller', reason: 'Only the room operator can do this.' });
    expect(await decide(SHOW, { kind: 'approve', id: ID(3) }, reasonOf)).toEqual({ ok: false, errorKey: 'not_operator' });
  });
});

describe('Open chat: the deep link', () => {
  it('opens the Moderation tab on the waiting list with that message', () => {
    expect(deepLink(ID(5))).toEqual({ open: true, tab: 'mod', filter: 'pending', focusId: ID(5) });
  });
  it('the message row is highlighted and reachable (id, aria-current), the others are not', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{ chat: enChat }} timeZone="UTC">
        <ModerationView showId={SHOW} queue={queue([qm(1), qm(2)])} filter="pending" onFilter={() => {}} onChanged={() => {}} locale="en" focusId={ID(2)} />
      </NextIntlClientProvider>,
    );
    const rows = html.split('<li ').slice(1);
    const hit = rows.filter((r) => r.includes('is-focus'));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain(`id="hc-q-${ID(2)}"`);
    expect(hit[0]).toContain('aria-current="true"');
    expect(rows.find((r) => r.includes(`id="hc-q-${ID(1)}"`))).not.toContain('is-focus');
  });
});
