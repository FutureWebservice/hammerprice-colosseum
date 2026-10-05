/**
 * The chat UI states on the server render with the real message files, in both languages: a visitor without a wallet (the "connect your wallet" card
 * in place of the composer, nothing to send), a session still loading, a sign-in under way, a signed-in wallet (the composer), and the cards. No DOM
 * library is installed, so what happens on a click (Enter to send, the stepper) is not covered here; the server logic is covered by the
 * route and agent tests. The session is a stand-in (session-mock.ts).
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import de from '@/locales/de/ai.json';
import en from '@/locales/en/ai.json';
import deAccount from '@/locales/de/account.json';
import enAccount from '@/locales/en/account.json';
import { resetSession, session } from './session-mock';

(globalThis as { React?: unknown }).React = React;
vi.mock('@/components/auth/SessionProvider', async () => (await import('./session-mock')).sessionModule());

const { default: AgentChat, CardView } = await import('../AgentChat');
const { default: AskPanel } = await import('../AskPanel');
const { RoomAssistant } = await import('@/components/room/slots/Assistant');

const MESSAGES = { de, en } as const;
const AUTH = { de: deAccount.session.auth, en: enAccount.session.auth } as const;
const wrap = (locale: 'de' | 'en', node: React.ReactNode) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={{ ai: MESSAGES[locale], account: locale === 'de' ? deAccount : enAccount }} timeZone="Europe/Berlin" onError={(e) => { throw e; }} getMessageFallback={({ key }) => { throw new Error(`missing message ${key}`); }}>{node}</NextIntlClientProvider>,
);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(resetSession);

describe.each(['en', 'de'] as const)('the chat (%s)', (l) => {
  const m = MESSAGES[l];
  const chat = () => wrap(l, <AgentChat locale={l} />);

  it('anonymous: the chat is there, the composer is not; a connect card with a button takes its place, the chips cannot be used, nothing can be sent', () => {
    const h = chat();
    expect(h).toContain('data-session="anonymous"');
    expect(h).toContain('data-testid="ai-gate"');
    expect(text(h)).toContain(m.gate.title);
    expect(text(h)).toContain(m.gate.body);
    expect(h).toMatch(/<button[^>]*data-testid="ai-gate-connect"[^>]*>/);
    expect(text(h)).toContain(m.gate.connect);
    expect(h).not.toContain('data-testid="ai-agent-input"');
    expect(h).not.toContain('data-testid="ai-agent-send"');
    for (const k of ['example1', 'example2', 'example3']) expect(h).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*data-testid="ai-agent-${k}"`));
    expect(h).toContain('data-testid="ai-agent-note"');
    expect(text(h)).toContain(m.agent.note);
    expect(text(h)).toContain(m.agent.intro.replace(/\s+/g, ' ')); // the welcome message: what the agent can do, in two short lines
  });
  it('a wallet that is connected but not signed in is asked to sign in, not to connect', () => {
    session.connected = true;
    expect(text(chat())).toContain(m.gate.signIn);
  });
  it('loading: the gate is busy and its button cannot be pressed (no flash of a composer)', () => {
    session.status = 'loading';
    const h = chat();
    expect(h).toContain('aria-busy="true"');
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-gate-connect"/);
    expect(text(h)).toContain(m.gate.loading);
    expect(h).not.toContain('data-testid="ai-agent-input"');
  });
  it('signing in: the button says it waits for the wallet; a cancelled signature is explained next to it', () => {
    session.status = 'signing-in'; session.connected = true;
    expect(text(chat())).toContain(m.gate.signingIn);
    resetSession();
    session.error = { code: 'wallet_rejected' };
    expect(text(chat())).toContain(AUTH[l].rejected);
    session.error = { code: 'network' };
    expect(text(chat())).toContain(AUTH[l].network);
  });
  it('signed in: a labelled auto-growing composer, a send button with a name, the one-sentence note, the three Pokemon chips usable, no gate', () => {
    session.status = 'signed-in';
    const h = chat();
    expect(h).toContain('data-session="signed-in"');
    expect(h).not.toContain('data-testid="ai-gate"');
    expect(h).toMatch(/<textarea[^>]*rows="1"[^>]*maxLength="300"|<textarea[^>]*maxlength="300"/i);
    expect(h).toMatch(/<label[^>]*for="([^"]+)-q"[^>]*>/);
    const forId = /<label[^>]*for="([^"]+)"/.exec(h)![1]!;
    expect(h).toContain(`id="${forId}"`);
    expect(h).toMatch(new RegExp(`aria-describedby="${forId.replace(/-q$/, '')}-hint"`));
    expect(h).toMatch(new RegExp(`id="${forId.replace(/-q$/, '')}-hint"`));
    expect(h).toMatch(new RegExp(`aria-label="${m.agent.send}"[^>]*data-testid="ai-agent-send"|data-testid="ai-agent-send"[^>]*aria-label="${m.agent.send}"`));
    expect(text(h)).toContain(m.agent.note);
    for (const k of ['example1', 'example2', 'example3'] as const) {
      expect(text(h)).toContain(m.agent[k]);
      expect(h).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*data-testid="ai-agent-${k}"`));
    }
    expect(m.agent.example1).toMatch(/Pokemon/);
  });
  it('the conversation is one polite live log with a name and a keyboard stop, and the new-chat button only exists once there is a conversation', () => {
    session.status = 'signed-in';
    const h = chat();
    expect(h.match(/role="log"/g)).toHaveLength(1);
    expect(h).toMatch(/role="log"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="log"/);
    expect(h).toContain(`aria-label="${m.agent.log}"`);
    expect(h).toMatch(/role="log"[^>]*tabindex="0"|tabindex="0"[^>]*role="log"/i);
    expect(h).not.toContain('data-testid="ai-agent-new"');
  });
  it('the page is a full-height column: a slim top bar with the one h1, a log, a foot with the composer; the examples are cards', () => {
    session.status = 'signed-in';
    const h = chat();
    expect(h).toContain('agc--page');
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h.indexOf('agc-bar')).toBeLessThan(h.indexOf('agc-log'));
    expect(h.indexOf('agc-log')).toBeLessThan(h.indexOf('agc-foot'));
    expect(h.match(/class="agc-ex"/g)).toHaveLength(3);
    expect(h).not.toContain('data-testid="ai-agent-close"');
    expect(h).not.toContain('data-testid="ai-agent-room"');
  });
  it('one tiny line under the composer says the chat is saved in this browser only, and only while signed in (nothing is kept without a wallet)', () => {
    expect(chat()).not.toContain('data-testid="ai-agent-saved"');
    session.status = 'signed-in';
    const h = chat();
    expect(h.match(/data-testid="ai-agent-saved"/g)).toHaveLength(1);
    expect(text(h)).toContain(m.agent.saved);
    expect(text(h)).toContain(m.agent.note);
  });
  it('no personal-data notice anywhere in the chat', () => {
    session.status = 'signed-in';
    expect(text(chat())).not.toMatch(/not enter personal data|keine persönlichen Daten ein|sent to Google|an Google/);
  });
});

describe.each(['en', 'de'] as const)('the assistant drawer in a room (%s)', (l) => {
  const m = MESSAGES[l];
  const drawer = () => wrap(l, <AgentChat locale={l} variant="drawer" roomLot={{ lotId: id, lotNumber: 7, name: 'Charizard Holo' }} onClose={() => {}} />);
  it('is the same chat as the page (log, composer, hint), with an h2 instead of a second h1, a close button and the lot of the room', () => {
    session.status = 'signed-in';
    const h = drawer();
    expect(h).toContain('agc--drawer');
    expect(h).not.toContain('<h1');
    expect(h.match(/<h2/g)).toHaveLength(1);
    expect(h).toContain('data-testid="ai-agent-close"');
    expect(h).toContain(`aria-label="${m.agent.close}"`);
    expect(h).toContain('data-testid="ai-agent-input"');
    expect(text(h)).toContain(m.agent.roomContext.replace('{n}', '7'));
    for (const k of ['roomExample1', 'roomExample2', 'roomExample3'] as const) expect(text(h)).toContain(m.agent[k]);
    expect(text(h)).toContain(m.agent.saved);
  });
  it('anonymous: the connect card (no composer), exactly as on the page', () => {
    const h = drawer();
    expect(h).toContain('data-testid="ai-gate"');
    expect(h).not.toContain('data-testid="ai-agent-input"');
  });
});

describe.each(['en', 'de'] as const)('the cards (%s)', (l) => {
  const m = MESSAGES[l];
  const lot = (o: object = {}) => ({ lotId: id, showId: id, showTitle: 'Friday room', showStatus: 'live' as const, lotNumber: 3, name: 'Charizard Holo', setName: 'Base Set', grading: 'PSA 9', state: 'open' as const, priceUsdc: '30000000', hasBid: true, imageUrl: 'https://img.example/c.jpg', closesAt: new Date(Date.now() + 125_000).toISOString(), startsAt: null, ...o });
  it('a lot card: picture, name, grade, set, price, time left, a link into the room and a Prepare bid button', () => {
    const h = wrap(l, <CardView lang={l} card={{ type: 'lots', lots: [lot()] }} onPrepareBid={() => {}} />);
    expect(h).toContain('src="https://img.example/c.jpg"');
    expect(h).toContain('alt="Charizard Holo"');
    for (const s of ['Charizard Holo', 'PSA 9', 'Base Set', '30.00 USDC', m.agent.currentBid, m.agent.open, 'Friday room']) expect(text(h)).toContain(s);
    expect(text(h)).toMatch(l === 'en' ? /\d:\d\d left/ : /Noch \d:\d\d/);
    expect(h).toContain('role="timer"'); // a ticking clock is not announced every second
    expect(h).toContain(`href="/${l}/room/${id}"`);
    expect(text(h)).toContain(m.agent.openRoom);
    expect(text(h)).toContain(m.agent.prepareBid);
  });
  it('an upcoming lot has no Prepare bid, shows its opening price and when the room starts; a lot without a picture has a placeholder', () => {
    const h = wrap(l, <CardView lang={l} card={{ type: 'lots', lots: [lot({ state: 'catalogued', hasBid: false, imageUrl: null, closesAt: null, showStatus: 'scheduled', startsAt: '2030-01-05T19:00:00.000Z' })] }} onPrepareBid={() => {}} />);
    expect(text(h)).not.toContain(m.agent.prepareBid);
    expect(text(h)).toContain(m.agent.opening);
    expect(text(h)).toContain(m.agent.soon);
    expect(text(h)).toContain(m.agent.noPhoto);
    expect(h).not.toContain('<img');
    expect(h).not.toContain('role="timer"');
    expect(text(h)).toMatch(l === 'en' ? /Starts .*2030/ : /Beginnt .*2030/);
  });
  it('a picture address that is not https or our own is not drawn', () => {
    for (const u of ['javascript:alert(1)', 'http://insecure.example/c.jpg', 'data:image/svg+xml;base64,AAAA']) {
      expect(wrap(l, <CardView lang={l} card={{ type: 'lots', lots: [lot({ imageUrl: u })] }} />)).not.toContain('<img');
    }
    expect(wrap(l, <CardView lang={l} card={{ type: 'lots', lots: [lot({ imageUrl: '/cards/c.png' })] }} />)).toContain('src="/cards/c.png"');
  });
  it('a bid proposal: the next legal bid in a stepper, the limit, a link to confirm in the room (not a button), the note that nothing is bid', () => {
    const h = wrap(l, <CardView lang={l} card={{ type: 'bid', lotId: id, showId: id, lotNumber: 3, name: 'Charizard Holo', currentBidUsdc: '30000000', amountUsdc: '35000000', limitUsdc: '50000000', incrementUsdc: '5000000' }} />);
    expect(h).toMatch(/<output[^>]*data-testid="ai-agent-bid-amount"[^>]*>35\.00 USDC/);
    expect(h).toContain(`aria-label="${m.agent.bidDown}"`);
    expect(h).toContain(`aria-label="${m.agent.bidUp}"`);
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-agent-bid-down"/); // never below the next legal bid
    expect(h).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-agent-bid-up"/);
    expect(text(h)).toContain('50.00 USDC');
    expect(h).toMatch(/<a [^>]*data-testid="ai-agent-bid-confirm"/);
    expect(h).toContain(`href="/${l}/room/${id}"`);
    expect(text(h)).toContain(m.agent.bidConfirm);
    expect(text(h)).toContain(m.agent.bidNote);
  });
  it('a stepper whose limit equals the next legal bid cannot move at all', () => {
    const h = wrap(l, <CardView lang={l} card={{ type: 'bid', lotId: id, showId: id, lotNumber: 3, name: 'X', currentBidUsdc: null, amountUsdc: '35000000', limitUsdc: '35000000', incrementUsdc: '5000000' }} />);
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-agent-bid-down"/);
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*data-testid="ai-agent-bid-up"/);
    expect(text(h)).toContain(m.agent.bidNone);
  });
  it('a draft proposal: the details, the note, and one button that creates nothing until it is pressed', () => {
    const h = wrap(l, <CardView lang={l} card={{ type: 'draft', creditCost: 1, fields: { name: 'Blastoise', setName: 'Base Set', gradingCompany: 'PSA', grade: '8', estimateUsdc: '120000000' } }} />);
    for (const s of ['Blastoise', 'Base Set', 'PSA 8', '120.00 USDC', m.agent.draftNote, m.agent.draftCreate]) expect(text(h)).toContain(s);
    expect(h).not.toContain('data-testid="ai-agent-draft-result"');
  });
});

describe.each(['en', 'de'] as const)('the assistant in the sell wizard (%s)', (l) => {
  const m = MESSAGES[l];
  it('anonymous: the connect card replaces the question field and the example questions', () => {
    const h = wrap(l, <AskPanel locale={l} />);
    expect(h).toContain('data-testid="ai-gate"');
    expect(text(h)).toContain(m.gate.title);
    expect(h).not.toContain('data-testid="ai-ask-input"');
    expect(h).not.toContain('data-testid="ai-ask-send"');
  });
  it('signed in: the question field is there and the gate is not', () => {
    session.status = 'signed-in';
    const h = wrap(l, <AskPanel locale={l} />);
    expect(h).toContain('data-testid="ai-ask-input"');
    expect(h).not.toContain('data-testid="ai-gate"');
  });
});

describe.each(['en', 'de'] as const)('the room launcher of the assistant (%s)', (l) => {
  const m = MESSAGES[l];
  it('is one closed pill button with an icon and a short label, no old bar, no drawer until it is opened, and no personal-data notice', () => {
    const h = wrap(l, <RoomAssistant showId={id} locale={l} lot={{ id, lotNumber: 3, name: 'Charizard' }} />);
    expect(h).toMatch(/<button[^>]*class="hp-launch hp-launch--ai"[^>]*aria-expanded="false"/);
    expect(h).toContain('data-testid="ai-ask-open"');
    expect(text(h)).toContain(m.assistant.launch);
    expect(h).toContain(`aria-label="${m.assistant.open}"`);
    expect(h).toContain('<svg');
    expect(h).not.toContain('ai-askbar');
    expect(h).not.toContain('data-testid="ai-ask-panel"');
    expect(h).not.toContain('data-testid="ai-agent"');
    expect(text(h)).not.toMatch(/not enter personal data|keine persönlichen Daten ein|sent to Google|an Google/);
  });
  it('is shown to a visitor without a wallet too: the connect card is what the drawer says when it opens, never a reason to hide the button', () => {
    session.status = 'anonymous';
    const h = wrap(l, <RoomAssistant showId={id} locale={l} lot={null} />);
    expect(h).toContain('data-testid="ai-ask-open"');
    expect(text(h)).toContain(m.assistant.launch);
  });
});
