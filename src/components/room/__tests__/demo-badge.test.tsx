/**
 * The DEMO label: one badge and one plain sentence, the same words wherever the house room, its timed auctions or the house pack appear,
 * in German and English. A seller's room or pack never wears it.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('../room.css', () => ({}));
vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import enRooms from '@/locales/en/rooms.json';
import deRooms from '@/locales/de/rooms.json';
import enPacks from '@/locales/en/packs.json';
import dePacks from '@/locales/de/packs.json';
import type { PackView } from '@/contracts';
import PackTile from '@/components/packs/PackTile';
import { DemoBadge, DemoNote } from '../DemoBadge';

const MESSAGES = { en: { rooms: enRooms, packs: enPacks }, de: { rooms: deRooms, packs: dePacks } };
const wrap = (locale: 'en' | 'de', node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">{node}</NextIntlClientProvider>);
const wallet = 'A'.repeat(32);
const pack = (isHouse: boolean): PackView => ({
  id: '7b1c2d3e-4f50-4a61-8b72-000000000020', name: { de: 'Testpack', en: 'Test pack' }, description: null, imageUrl: null, mode: 'chance', status: 'live', cluster: 'devnet', price: '5000000',
  operator: { wallet, isHouse }, odds: [{ tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 10000, remaining: 3, total: 4 }], pool: { total: 4, remaining: 3 },
  commitment: { poolHash: 'ab'.repeat(32), oddsHash: 'cd'.repeat(32), committedAt: '2026-10-05T12:00:00.000Z' }, perWalletDailyCap: 5, vrfPublicKey: wallet, createdAt: '2026-10-05T12:00:00.000Z',
});

describe('DemoBadge and DemoNote', () => {
  it('say DEMO and the one plain sentence in English', () => {
    expect(wrap('en', <DemoBadge />)).toMatch(/data-testid="demo-badge"[^>]*>Demo</);
    const note = wrap('en', <DemoNote />);
    expect(note).toContain('data-testid="demo-note"');
    for (const part of ['Tutorial: practise bidding here.', 'The labelled bots never outbid a person.']) expect(note).toContain(part);
    // the panel is neutral: the network, the money and the replicas are named where a person acts (footer, faucet, network line), not here
    expect(note).not.toMatch(/test USDC|devnet|replica/i);
  });
  it('the room banner names what the tutorial shows, live or timed', () => {
    expect(wrap('en', <DemoNote kind="live" />)).toContain('Tutorial: how a live auction room works');
    expect(wrap('en', <DemoNote kind="timed" />)).toContain('Tutorial: how a timed auction works');
    expect(wrap('de', <DemoNote kind="timed" />)).toContain('Tutorial: So funktioniert eine Zeitauktion');
    // one "Tutorial:" only, then the bot line
    for (const [l, k] of [['en', 'live'], ['en', 'timed'], ['de', 'live'], ['de', 'timed']] as const) {
      const html = wrap(l, <DemoNote kind={k} />);
      expect(html.match(/Tutorial/g), `${l} ${k}`).toHaveLength(1);
      expect(html).toContain(l === 'en' ? 'The labelled bots never outbid a person.' : 'Die gekennzeichneten Bots überbieten nie eine Person.');
    }
  });
  it('say it in German', () => {
    const note = wrap('de', <DemoNote />);
    for (const part of ['Tutorial: Hier können Sie das Bieten üben.', 'Die gekennzeichneten Bots überbieten nie eine Person.']) expect(note).toContain(part);
    expect(note).not.toMatch(/Test-USDC|Devnet|Replik/i);
  });
  it('the house pack carries the badge, a seller pack does not', () => {
    expect(wrap('en', <PackTile pack={pack(true)} locale="en" demo />)).toContain('data-testid="demo-badge"');
    expect(wrap('de', <PackTile pack={pack(true)} locale="de" demo />)).toContain('data-testid="demo-badge"');
    expect(wrap('en', <PackTile pack={pack(false)} locale="en" />)).not.toContain('data-testid="demo-badge"');
  });
});
