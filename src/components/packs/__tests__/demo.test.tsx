/**
 * The devnet DEMO pack end and the way in for operators, rendered on the server in both languages: the reveal of a demo draw (card, grade, rarity, published odds, the
 * minted copy with its link, and the demo status line with its buttons), the odds bar, the demo and real pack cards, the explainer with the real availability state, and the purchase states.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/components/auth/SessionProvider', () => ({ useSession: () => ({ status: 'signed-out', me: null }) }));
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import deMessages from '@/locales/de/packs.json';
import enMessages from '@/locales/en/packs.json';
import deRooms from '@/locales/de/rooms.json';
import enRooms from '@/locales/en/rooms.json';
import type { PackDrawView, PackView } from '@/contracts';
import OddsBar from '../OddsBar';
import { OfferPackCta, OfferPackExplainer, accessKey } from '../OfferPack';
import PackTile from '../PackTile';
import PayProgress from '../PayProgress';
import Revealed from '../Revealed';
import { splitPacks } from '../PacksIndex';
import { payStepOf, stateAfterFollow } from '../purchase';
import { cardLine, previewOdds } from '../form';

(globalThis as unknown as { React: typeof React }).React = React;
const wrap = (locale: 'de' | 'en', node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ packs: locale === 'de' ? deMessages : enMessages, rooms: locale === 'de' ? deRooms : enRooms }}>{node}</NextIntlClientProvider>);

const W = (n: number) => String(n).repeat(32).slice(0, 32).replace(/0/g, 'A');
const ODDS = [
  { tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 6500, remaining: 3, total: 4 },
  { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 2500, remaining: 1, total: 1 },
  { tier: 'legend', label: { de: 'Legendär', en: 'Legendary' }, bps: 1000, remaining: 1, total: 1 },
];
const pack = (over: Partial<PackView> = {}): PackView => ({
  id: '7b1c2d3e-4f50-4a61-8b72-000000000020', name: { de: 'Starter-Pack', en: 'Starter pack' }, description: null, imageUrl: null, mode: 'chance', status: 'live', cluster: 'devnet', price: '5000000',
  operator: { wallet: W(1), isHouse: true }, odds: ODDS, pool: { total: 6, remaining: 6 }, commitment: { poolHash: 'ab'.repeat(32), oddsHash: 'cd'.repeat(32), committedAt: '2026-10-05T12:00:00.000Z' },
  perWalletDailyCap: 5, vrfPublicKey: W(2), createdAt: '2026-10-05T12:00:00.000Z', ...over,
});
const demoDraw = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000aa', packId: pack().id, drawIndex: 0, status: 'demo_revealed', cluster: 'devnet', buyer: W(5), clientSeed: 'a'.repeat(32), poolHash: 'ab'.repeat(32),
  vrf: { requestId: null, status: null, input: null, proofHex: null, outputHex: null }, revealed: true, tier: 'rare', card: { asset: W(3), name: 'Charizard', imageUrl: 'https://example.com/c.png', tier: 'rare', grade: 'PSA 10' },
  price: '5000000', settlementRef: null, txSignature: '4'.repeat(88), deliverySignature: null, deliverBy: null, createdAt: '2026-10-05T12:00:00.000Z', settledAt: '2026-10-05T12:01:00.000Z', flow: 'pay_first', operator: { wallet: W(1), isHouse: true }, ...over,
}) as unknown as PackDrawView;

describe('the demo end of the house pack', () => {
  const MINT_SIG = '6'.repeat(88);
  it.each(['en', 'de'] as const)('shows the drawn card, its grade, rarity and published chance, the explorer link of the REAL payment, the minted copy and its link, and the one demo status line with both buttons (%s)', (locale) => {
    const html = wrap(locale, <Revealed draw={demoDraw({ deliverySignature: MINT_SIG })} pack={pack()} locale={locale} onAnother={() => undefined} />);
    expect(html).toContain('data-testid="revealed"');
    expect(html).toContain('Charizard');
    expect(html).toContain('PSA 10');
    expect(html).toContain('data-testid="reveal-grade"');
    expect(html).toContain('25 %'); // the published chance of the drawn tier
    expect(html).toContain(`https://explorer.solana.com/tx/${'4'.repeat(88)}?cluster=devnet`); // the payment trail stays
    expect(html).toContain('/verify/packs/00000000-0000-4000-8000-0000000000aa'); // and the proof page
    expect(html).toContain('data-testid="demo-outcome"');
    expect(html).toContain('href="/packs#real-packs"');
    expect(html).toContain('href="/packs/manage"');
    expect(html).toContain('data-testid="view-delivery"'); // the mint transaction of the copy
    expect(html).toContain(`https://explorer.solana.com/tx/${MINT_SIG}?cluster=devnet`);
    if (locale === 'en') {
      expect(html).toContain('You drew Charizard');
      expect(html).toContain('Demo draw: a copy of this card was minted into your wallet.');
      expect(html).toContain('Minted copy');
      expect(html).toContain('Browse real packs');
      expect(html).toContain('Offer a pack');
    } else {
      expect(html).toContain('Sie haben Charizard gezogen');
      expect(html).toContain('Demo-Ziehung: Eine Kopie dieser Karte wurde in Ihre Wallet geprägt.');
      expect(html).toContain('Geprägte Kopie');
      expect(html).toContain('Echte Packs ansehen');
      expect(html).toContain('Pack anbieten');
    }
    expect(html).not.toMatch(/nothing is delivered|geliefert wird nichts/);
  });
  it.each(['en', 'de'] as const)('a demo draw whose copy could not be minted still shows the card and says so, without a mint link (%s)', (locale) => {
    const html = wrap(locale, <Revealed draw={demoDraw()} pack={pack()} locale={locale} onAnother={() => undefined} />);
    expect(html).toContain('Charizard');
    expect(html).toContain('data-testid="demo-outcome"');
    expect(html).not.toContain('data-testid="view-delivery"');
    expect(html).toContain(locale === 'en' ? 'no copy was minted into your wallet this time' : 'diesmal wurde keine Kopie in Ihre Wallet geprägt');
  });
  it('a delivered card of a real pack carries no demo notice and keeps its delivery link', () => {
    const html = wrap('en', <Revealed draw={demoDraw({ status: 'settled', deliverySignature: '5'.repeat(88), operator: { wallet: W(7), isHouse: false } })} pack={pack({ operator: { wallet: W(7), isHouse: false } })} locale="en" onAnother={() => undefined} />);
    expect(html).not.toContain('data-testid="demo-outcome"');
    expect(html).toContain('You received Charizard');
    expect(html).toContain('data-testid="view-delivery"');
  });
  it('the reveal is one calm column: no explanatory block, one compact legal line with the single "How packs work" link', () => {
    for (const locale of ['en', 'de'] as const) {
      const html = wrap(locale, <Revealed draw={demoDraw()} pack={pack()} locale={locale} onAnother={() => undefined} />);
      expect(html).not.toMatch(/safety-panel|pk-safety|honest|ehrlich/i);
      expect((html.match(/data-testid="pack-notice"/g) ?? []).length).toBe(1);
      expect(html).toContain('href="/packs#how"');
      expect(html).toContain(locale === 'en' ? 'How packs work' : 'So funktionieren Packs');
      expect(html).toContain(locale === 'en' ? '18+. Seller: Hammerprice (demo pack, a copy of the card you draw is minted into your wallet)' : 'Ab 18. Verkäufer: Hammerprice (Demo-Pack, eine Kopie der gezogenen Karte wird in Ihre Wallet geprägt)');
    }
  });
  it('the purchase state ends at once: a demo draw is a terminal "settled" screen with the reveal, the fourth step reads "Demo end" and is done', () => {
    expect(stateAfterFollow(demoDraw())).toMatchObject({ kind: 'settled' });
    expect(payStepOf('demo_revealed')).toBe('done');
    expect(wrap('en', <PayProgress draw={demoDraw({ status: 'paid' })} />)).toContain('Demo end');
    expect(wrap('de', <PayProgress draw={demoDraw({ status: 'paid' })} />)).toContain('Demo-Ende');
    expect(wrap('en', <PayProgress draw={demoDraw({ status: 'paid', operator: { wallet: W(7), isHouse: false } })} />)).toContain('Deliver');
  });
});

describe('the published odds on every pack', () => {
  it('draws one bar and names every tier with its percentage, in both languages', () => {
    const en = wrap('en', <OddsBar odds={ODDS} locale="en" />);
    expect(en).toContain('data-testid="odds-bar"');
    expect(en).toContain('Common');
    expect(en).toContain('65 %');
    expect(en).toContain('25 %');
    expect(en).toContain('10 %');
    expect(en).toContain('width:65%');
    expect(en).toContain('role="img"');
    const de = wrap('de', <OddsBar odds={ODDS} locale="de" compact />);
    expect(de).toContain('Häufig');
    expect(de).toContain('65 %');
  });
});

describe('the packs list: demo packs first, real packs below', () => {
  const real = pack({ id: '7b1c2d3e-4f50-4a61-8b72-000000000021', operator: { wallet: W(7), isHouse: false }, operatorRecord: { delivered: 12, late: 1, undelivered: 2, medianDeliverySeconds: 600 } });
  it('splits house demo packs (at most two) from the real packs of sellers and keeps the order', () => {
    const a = pack({ id: 'a' }), b = pack({ id: 'b' }), c = pack({ id: 'c' });
    expect(splitPacks([a, real, b, c]).demo.map((p) => p.id)).toEqual(['a', 'b']);
    expect(splitPacks([a, real, b, c]).real).toEqual([real]);
    expect(splitPacks([real]).demo).toEqual([]);
    expect(splitPacks([a]).demo).toHaveLength(1); // the one that exists is shown, nothing is invented
  });
  it.each(['en', 'de'] as const)('a demo card has the Demo chip, the tutorial line, the price, the odds bar, a pool preview and the primary "Open demo pack" button (%s)', (locale) => {
    const cards = [{ id: 'x1', position: 0, asset: W(3), tier: 'common', name: 'Card A', imageUrl: 'https://example.com/a.png', listedValue: null, status: 'available' as const }];
    const html = wrap(locale, <PackTile pack={pack()} locale={locale} demo cards={cards} />);
    expect(html).toContain('data-testid="demo-pack-tile"');
    expect(html).toContain('data-testid="demo-badge"');
    expect(html).toContain('data-testid="tutorial-line"');
    expect(html).toContain('data-testid="odds-bar"');
    expect(html).toContain('data-testid="pool-preview"');
    expect(html).toContain('https://example.com/a.png');
    expect(html).toContain(locale === 'en' ? '$5.00' : '5,00');
    expect(html).toContain(`href="/packs/${pack().id}"`);
    expect(html).toMatch(/class="hpx-btn pl-cta"[^>]*data-testid="demo-pack-open"/);
    expect(html).toContain(locale === 'en' ? 'Open demo pack' : 'Demo-Pack öffnen');
    expect(html).toContain(locale === 'en' ? 'Tutorial on devnet: you are not charged, and a copy of the card you draw is minted into your wallet.' : 'Tutorial im Devnet: Es wird nichts berechnet, und eine Kopie der gezogenen Karte wird in Ihre Wallet geprägt.');
    expect(html).not.toMatch(/test USDC|Test-USDC/i);
  });
  it.each(['en', 'de'] as const)('a real card shows the seller, the price, the odds bar, the pool size and the seller\'s delivery record (%s)', (locale) => {
    const html = wrap(locale, <PackTile pack={real} locale={locale} />);
    expect(html).toContain('data-testid="pack-tile"');
    expect(html).not.toContain('data-testid="demo-badge"');
    expect(html).toContain(locale === 'en' ? 'Seller 7777…7777' : 'Verkäufer 7777…7777');
    expect(html).toContain(locale === 'en' ? 'Delivered: 12, not delivered: 2' : 'Geliefert: 12, nicht geliefert: 2');
    expect(html).toContain('data-testid="odds-bar"');
    expect(html).toContain(locale === 'en' ? '6 cards' : '6 Karten');
  });
  it('a seller without any record says so instead of looking good', () => {
    expect(wrap('en', <PackTile pack={pack({ operator: { wallet: W(7), isHouse: false }, operatorRecord: null })} locale="en" />)).toContain('No delivery record yet');
  });
});

describe('offer a pack: the explainer and the real availability', () => {
  it.each(['en', 'de'] as const)('says what an operator does, in nine plain steps in two lists, with a link to the operator flow (%s)', (locale) => {
    const html = wrap(locale, <OfferPackExplainer />);
    expect(html).toContain('id="how"');
    expect((html.match(/<li>/g) ?? []).length).toBe(9);
    expect(html).toContain('href="/packs/manage"');
    expect(html).toContain(locale === 'en' ? '100 percent' : '100 Prozent');
    expect(html).toContain(locale === 'en' ? '18 or older' : 'mindestens 18 Jahre');
    expect(html).toContain('data-testid="offer-access"');
  });
  it.each(['en', 'de'] as const)('holds every detail the landing page links to, once: the anchors #build, #odds and #delivery, the odds as the code draws them and the money flow (%s)', (locale) => {
    const html = wrap(locale, <OfferPackExplainer />);
    const all = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const en = locale === 'en';
    // the three anchors the landing links point at, in this order, one each
    const at = ['build', 'odds', 'delivery'].map((id) => { expect(html.match(new RegExp(`id="${id}"`, 'g')), id).toHaveLength(1); return html.indexOf(`id="${id}"`); });
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // the odds, as selectFromPool draws them
    expect(all).toMatch(en ? /10,000/ : /10\.000/);
    expect(all).toMatch(en ? /0 to 9,999/ : /0 bis 9\.999/);
    expect(all).toContain('/verify/packs/');
    expect(all).toMatch(en ? /equally likely/ : /gleich wahrscheinlich/);
    expect(all).toMatch(en ? /drops out of that draw/ : /fällt sie bei dieser Ziehung weg/);
    // the worked example is arithmetic that holds: 7000 + 2500 + 500, the ranges, half of 5 percent
    const bps = [7000, 2500, 500];
    expect(bps.reduce((a, b) => a + b, 0)).toBe(10000);
    expect([0, 7000, 9500].map((x, i) => x + bps[i]! - 1)).toEqual([6999, 9499, 9999]);
    expect(all).toMatch(en ? /9,612.*Chase.*2\.5 percent/ : /9\.612.*Chase.*2,5 Prozent/);
    // how to build, delivery, no pool
    expect(all).toMatch(en ? /1 to 8 tiers/ : /1 bis 8 Stufen/);
    expect(all).toMatch(en ? /never a promise/ : /nie ein Versprechen/);
    expect(all).toMatch(en ? /pause, resume or close/ : /pausieren, fortsetzen oder schließen/);
    expect(all).toMatch(en ? /20 strikes/ : /20 Verwarnungen/);
    expect(all).toMatch(en ? /delivery record/ : /Lieferbilanz/);
    expect(all).toMatch(en ? /holds no pool, no money and no cards, so it cannot refund/ : /hält keinen Pool, kein Geld und keine Karten und kann deshalb einem Käufer nichts erstatten/);
    expect(all).not.toContain('\u2014');
  });
  it('the availability sentence follows the real state of the allowlist logic', () => {
    const ready = (mode: 'open' | 'invited' | 'closed', allowed: boolean | null) => accessKey({ kind: 'ready', access: { mode, allowed } });
    expect(ready('open', null)).toEqual({ key: 'offer.access.open', allowed: null });
    expect(ready('open', true)).toEqual({ key: 'offer.access.openYes', allowed: true });
    expect(ready('invited', null).key).toBe('offer.access.invited');
    expect(ready('invited', true)).toEqual({ key: 'offer.access.invitedYes', allowed: true });
    expect(ready('invited', false)).toEqual({ key: 'offer.access.invitedNo', allowed: false });
    expect(ready('closed', null)).toEqual({ key: 'offer.access.closed', allowed: false });
    expect(accessKey({ kind: 'loading' }).allowed).toBeNull();
    for (const k of ['loading', 'unknown', 'open', 'openYes', 'invited', 'invitedYes', 'invitedNo', 'closed']) {
      expect((enMessages.offer.access as Record<string, string>)[k]).toBeTruthy();
      expect((deMessages.offer.access as Record<string, string>)[k]).toBeTruthy();
    }
  });
  it('the sell page panel leads to the operator flow and to the explainer', () => {
    const html = wrap('en', <OfferPackCta />);
    expect(html).toContain('data-testid="sell-offer-pack"');
    expect(html).toContain('href="/packs/manage"');
    expect(html).toContain('href="/packs#how"');
    expect(wrap('de', <OfferPackCta />)).toContain('Pack anbieten');
  });
});

describe('the operator form helpers', () => {
  it('previews the odds typed so far and their sum in basis points, skipping lines that are not valid yet', () => {
    const p = previewOdds('common; Häufig; Common; 70\nrare; Selten; Rare; 25\nbroken line\nlegend; Legendär; Legendary; 5');
    expect(p.rows.map((r) => r.tier)).toEqual(['common', 'rare', 'legend']);
    expect(p.sumBps).toBe(10_000);
    expect(previewOdds('common; a; b; 70').sumBps).toBe(7000);
    expect(previewOdds('').rows).toEqual([]);
  });
  it('turns a wallet card into a pool line the form parser reads back (tier from the first odds line, no semicolon inside the name)', () => {
    const line = cardLine({ mint: '2RvovZcQ2eNqDXGBuaRdGoQhYWnwUV2ocQHyXQe2d1Pd', name: 'Card; one', imageUrl: 'https://example.com/a.png' }, 'common');
    expect(line).toBe('2RvovZcQ2eNqDXGBuaRdGoQhYWnwUV2ocQHyXQe2d1Pd; common; Card, one; https://example.com/a.png; ');
    expect(cardLine({ mint: 'M', name: 'X', imageUrl: 'http://insecure' }, 't')).toBe('M; t; X; ; ');
  });
});
