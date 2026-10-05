/**
 * The /ai page in both languages (server render, real message files): the agent chat and nothing else (one h1, the welcome message, the example chips, the
 * connect card, the one sentence under the chat), the off state, the card kinds, the AI_FREE credits UI, the links from the header, the footer, the landing
 * page and the sitemap. No DOM library is installed: clicks are covered by the browser specs, the server logic by src/server/ai/__tests__/agent.test.ts.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import deAi from '@/locales/de/ai.json';
import enAi from '@/locales/en/ai.json';
import { allOnEnv } from '@/content/features';
import { sitemapPaths } from '@/lib/site-routes';

(globalThis as { React?: unknown }).React = React;
vi.mock('@/components/auth/SessionProvider', async () => (await import('./session-mock')).sessionModule());
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children) }));

const { default: AiPage, aiPageMetadata, AI_PAGE_MESSAGES } = await import('../AiPage');
const { CardView } = await import('../AgentChat');

const MESSAGES = { de: { ai: deAi }, en: { ai: enAi } } as const;
const wrap = (locale: 'de' | 'en', node: React.ReactNode) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Berlin" onError={(e) => { throw e; }} getMessageFallback={({ key }) => { throw new Error(`missing message ${key}`); }}>{node}</NextIntlClientProvider>,
);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const leaves = (o: unknown, p = ''): [string, string][] => (typeof o === 'string' ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k)));
const page = (l: 'de' | 'en', env: Record<string, string | undefined>) => wrap(l, <AiPage locale={l} env={env} />);
const on = allOnEnv('devnet');

describe.each(['en', 'de'] as const)('AiPage (%s)', (l) => {
  const m = AI_PAGE_MESSAGES[l];
  const h = page(l, on);

  it('is the chat and nothing else: one h1, no other heading, the welcome message, the three example chips and the one sentence under the chat', () => {
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).not.toMatch(/<h[2-6]/);
    expect(h).toContain('data-testid="ai-agent"');
    expect(text(h)).toContain(MESSAGES[l].ai.agent.title);
    expect(text(h)).toContain(MESSAGES[l].ai.agent.intro.split('\n')[0]);
    for (const k of ['example1', 'example2', 'example3']) expect(h).toContain(`data-testid="ai-agent-${k}"`);
    expect(text(h)).toContain(MESSAGES[l].ai.agent.example1);
    expect(text(h)).toContain(MESSAGES[l].ai.agent.example3);
    expect(h).toContain('data-testid="ai-gate"'); // signed out: the connect card
    expect(h.match(/data-testid="ai-agent-note"/g)).toHaveLength(1);
    expect(text(h)).toContain(MESSAGES[l].ai.agent.note);
    expect(h).not.toContain('data-testid="ai-use-'); // the long sections are gone
    expect(h).not.toContain('data-testid="ai-status"');
    expect(h).not.toContain('data-testid="ai-free"');
  });
  it('is drawn without the chat when the AI switch is off: the title and one line, no chat', () => {
    const off = page(l, { ...on, FEATURE_AI: 'false' });
    expect(off.match(/<h1/g)).toHaveLength(1);
    expect(text(off)).toContain(m.title);
    expect(off).toContain('data-testid="ai-try-off"');
    expect(text(off)).toContain(m.off);
    expect(off).not.toContain('data-testid="ai-agent"');
  });
  it('has metadata with its own canonical path, title and description', () => {
    const md = aiPageMetadata(l) as { title: string; description: string; alternates: { canonical: string } };
    expect(md.title).toBe(m.meta.title);
    expect(md.alternates.canonical).toMatch(new RegExp(`/${l}/ai$`));
  });
  it('draws the three card kinds: lots link to the room, a bid card only links to the room, a draft card has a button', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const lots = wrap(l, <CardView lang={l} card={{ type: 'lots', lots: [{ lotId: id, showId: id, showTitle: 'Room', showStatus: 'live', lotNumber: 3, name: 'Charizard', setName: null, grading: 'PSA 9', state: 'open', priceUsdc: '30000000', hasBid: true, imageUrl: null, closesAt: null, startsAt: null }] }} />);
    expect(lots).toContain(`href="/${l}/room/${id}"`);
    expect(text(lots)).toContain('30.00 USDC');
    const bid = wrap(l, <CardView lang={l} card={{ type: 'bid', lotId: id, showId: id, lotNumber: 3, name: 'Charizard', currentBidUsdc: '30000000', amountUsdc: '35000000', limitUsdc: '40000000', incrementUsdc: '5000000' }} />);
    expect(bid).toContain('data-testid="ai-agent-bid-confirm"');
    expect(bid).toMatch(/<a [^>]*data-testid="ai-agent-bid-confirm"/); // a link, not a button that acts
    expect(bid).not.toMatch(/<button[^>]*data-testid="ai-agent-bid-confirm"/);
    expect(text(bid)).toContain(MESSAGES[l].ai.agent.bidNote);
    const paid = wrap(l, <CardView lang={l} card={{ type: 'draft', creditCost: 1, fields: { name: 'Blastoise' } }} />);
    expect(paid).toContain('data-testid="ai-agent-draft-create"');
    expect(text(paid)).toContain(MESSAGES[l].ai.agent.draftCreate);
    const free = wrap(l, <CardView lang={l} card={{ type: 'draft', creditCost: 0, fields: { name: 'Blastoise' } }} />);
    expect(text(free)).toContain(MESSAGES[l].ai.agent.draftCreateFree);
  });
});

describe('credits UI with AI_FREE', () => {
  it('shows only the free note: no balance, no pack, no buy button; without AI_FREE the balance and the buy button are there', async () => {
    const { default: CreditsBar } = await import('../CreditsBar');
    vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null, signTransaction: undefined }) }));
    const base = { balance: 0, pack: { credits: 10, priceUsdc: '1000000' }, packsLeftToday: 3, cluster: 'devnet' as const, configured: true };
    for (const l of ['en', 'de'] as const) {
      const free = wrap(l, <CreditsBar credits={{ ...base, free: true }} onBought={() => {}} />);
      expect(free).toContain('data-testid="ai-free"');
      expect(text(free)).toContain(MESSAGES[l].ai.credits.freeNote);
      expect(free).not.toContain('data-testid="ai-balance"');
      expect(free).not.toContain('data-testid="ai-pack"');
      const paid = wrap(l, <CreditsBar credits={base} onBought={() => {}} />);
      expect(paid).toContain('data-testid="ai-balance"');
      expect(paid).not.toContain('data-testid="ai-free"');
    }
  });
});

describe('wording', () => {
  it('no em dash or en dash anywhere in the page texts or the agent texts, and both languages have the same keys', () => {
    for (const [k, v] of [...leaves(AI_PAGE_MESSAGES.en), ...leaves(AI_PAGE_MESSAGES.de), ...leaves(enAi.agent), ...leaves(deAi.agent)]) expect(v, k).not.toMatch(/[\u2014–]/);
    expect(leaves(AI_PAGE_MESSAGES.de).map(([k]) => k).sort()).toEqual(leaves(AI_PAGE_MESSAGES.en).map(([k]) => k).sort());
    expect(leaves(deAi.agent).map(([k]) => k).sort()).toEqual(leaves(enAi.agent).map(([k]) => k).sort());
  });
  it('the German texts address the reader formally', () => {
    for (const [k, v] of [...leaves(AI_PAGE_MESSAGES.de), ...leaves(deAi.agent)]) expect(v, k).not.toMatch(/\b(du|dein|deine|deinen|dir|dich)\b/i);
  });
});

describe('where the page is linked', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  it('is in the site routes and so in the sitemap (both languages)', () => {
    expect(sitemapPaths('en')).toContain('/ai');
    expect(sitemapPaths('de')).toContain('/ai');
  });
  it('is in the header nav, the footer, the landing hero and the landing journeys', () => {
    expect(read('src/components/layout/Header.tsx')).toContain("path: '/ai'");
    expect(read('src/components/layout/Footer.tsx')).toContain("['/ai', 'ai']"); // the footer lists the same items as the header
    expect(read('src/components/landing/HammerpriceLanding.tsx')).toContain("`/${locale}/ai`");
    expect(read('src/components/landing/journeys/Journeys.tsx')).toContain("reg: 'ai'");
    for (const l of ['en', 'de']) {
      for (const f of ['nav']) expect(JSON.parse(read(`src/locales/${l}/${f}.json`)).ai.length).toBeGreaterThan(1);
      expect(JSON.parse(read(`src/locales/${l}/landing.json`)).cta.tryAgent.length).toBeGreaterThan(5);
      expect(JSON.parse(read(`src/locales/${l}/features.json`)).items.ai.more.length).toBeGreaterThan(5);
    }
  });
});
