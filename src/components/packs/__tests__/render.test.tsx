/**
 * What the screens say, rendered on the server (no browser needed): the odds table, the pool, the commitment, the compact notice and the card
 * markup, in both languages and in the wording of both networks.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => <a href={href} {...rest}>{children}</a> })); // next-intl navigation needs a Next runtime
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import deMessages from '@/locales/de/packs.json';
import enMessages from '@/locales/en/packs.json';
import type { PackDetailResponse, PackView } from '@/contracts';
import CommitBox from '../CommitBox';
import HoloCard from '../HoloCard';
import OddsTable from '../OddsTable';
import PackArt, { accentOf } from '../PackArt';
import PoolGrid from '../PoolGrid';
import PackNotice from '../PackNotice';
import PayProgress from '../PayProgress';
import Undelivered from '../Undelivered';

const wallet = (n: number) => `${String(n).repeat(32)}`.slice(0, 32).replace(/0/g, 'A');
const pack = (over: Partial<PackView> = {}): PackView => ({
  id: '7b1c2d3e-4f50-4a61-8b72-000000000020', name: { de: 'Testpack', en: 'Test pack' }, description: null, imageUrl: null, mode: 'chance', status: 'live', cluster: 'devnet', price: '5000000',
  operator: { wallet: wallet(1), isHouse: true }, odds: [
    { tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 7000, remaining: 3, total: 4 }, { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 2800, remaining: 1, total: 1 }, { tier: 'legend', label: { de: 'Legendär', en: 'Legendary' }, bps: 200, remaining: 0, total: 1 },
  ], pool: { total: 6, remaining: 4 }, commitment: { poolHash: 'ab'.repeat(32), oddsHash: 'cd'.repeat(32), committedAt: '2026-10-05T12:00:00.000Z' }, perWalletDailyCap: 5, vrfPublicKey: wallet(2), createdAt: '2026-10-05T12:00:00.000Z', ...over,
});
const cards: PackDetailResponse['cards'] = [
  { id: '00000000-0000-4000-8000-000000000001', position: 0, asset: wallet(3), tier: 'common', name: 'Card A', imageUrl: 'https://example.com/a.png', listedValue: '25000000', status: 'available' },
  { id: '00000000-0000-4000-8000-000000000002', position: 1, asset: wallet(4), tier: 'legend', name: 'Card Z', imageUrl: null, listedValue: '120000000', status: 'drawn' },
];
const wrap = (locale: 'de' | 'en', node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ packs: locale === 'de' ? deMessages : enMessages }}>{node}</NextIntlClientProvider>);
(globalThis as unknown as { React: typeof React }).React = React; // no automatic JSX runtime in the test transform
afterEach(() => vi.unstubAllEnvs());

describe('odds table', () => {
  it('shows every rarity with its published chance and how many cards are left, in both languages', () => {
    const en = wrap('en', <OddsTable pack={pack()} locale="en" />);
    expect(en).toContain('Common');
    expect(en).toContain('70\u00a0%');
    expect(en).toContain('28\u00a0%');
    expect(en).toContain('2\u00a0%');
    expect(en).toContain('3 / 4');
    expect(en).toContain('0 / 1');
    expect(en).toContain('data-testid="odds-legend"');
    const de = wrap('de', <OddsTable pack={pack()} locale="de" />);
    expect(de).toContain('Häufig');
    expect(de).toContain('Chance');
    expect(de).toContain('28\u00a0%');
  });
  it('gives the rarest tier the top look and the likeliest the plain one', () => {
    const html = wrap('en', <OddsTable pack={pack()} locale="en" />);
    expect(html).toMatch(/data-testid="odds-common"[^>]*|data-rarity="common"[^>]*data-testid="odds-common"/);
    expect(html).toContain('data-rarity="legendary"');
    expect(html).toContain('data-rarity="common"');
  });
});

describe('pool grid', () => {
  it('lists every card with its tier and marks a drawn one', () => {
    const html = wrap('en', <PoolGrid pack={pack()} cards={cards} locale="en" />);
    expect(html).toContain('Card A');
    expect(html).toContain('Card Z');
    expect(html).toContain('Drawn');
    expect(html).toContain('$25.00');
    expect(html).toContain('listed value');
  });
});

describe('commitment box', () => {
  it('shows the pool hash, the odds hash, the time and the draw key', () => {
    const html = wrap('en', <CommitBox pack={pack()} locale="en" />);
    expect(html).toContain('ab'.repeat(32));
    expect(html).toContain('cd'.repeat(32));
    expect(html).toContain('UTC');
    expect(html).toContain(wallet(2));
  });
  it('says so when nothing is committed yet', () => {
    expect(wrap('en', <CommitBox pack={pack({ commitment: { poolHash: null, oddsHash: null, committedAt: null }, vrfPublicKey: null })} locale="en" />)).toContain('Not committed yet');
  });
});

describe('the compact notice: one line, the same on every network', () => {
  it('names 18+, the seller as counterparty, the delivery deadline and the single explainer link, in both languages, without test-money wording', () => {
    const third = pack({ operator: { wallet: wallet(7), isHouse: false }, operatorRecord: { delivered: 12, late: 3, undelivered: 1, medianDeliverySeconds: 7500 } });
    for (const cluster of ['devnet', 'mainnet-beta']) {
      vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', cluster);
      const en = wrap('en', <PackNotice pack={third} />);
      expect(en).toContain('data-testid="pack-notice"');
      expect(en).toContain('18+');
      expect(en).toContain('Your counterparty is the seller 7777…7777 (12 delivered, 1 not delivered)');
      expect(en).toContain('within 24 hours of the draw');
      expect(en).toContain('cannot refund you');
      expect(en).toContain('Odds and pool are public');
      expect(en).toContain('href="/packs#how"');
      const de = wrap('de', <PackNotice pack={third} />);
      expect(de).toContain('Ab 18');
      expect(de).toContain('Vertragspartner ist der Verkäufer 7777…7777 (12 geliefert, 1 nicht geliefert)');
      expect(de).toContain('24 Stunden');
      expect(de).toContain('nichts erstatten');
      expect(en.replace(/data-testid="[^"]*"/g, '')).not.toMatch(/test|replica/i);
    }
  });
  it('says what is different for the house demo, an equal-value pack and a seller without a record', () => {
    expect(wrap('en', <PackNotice pack={pack()} />)).toContain('Seller: Hammerprice (demo pack, a copy of the card you draw is minted into your wallet)');
    expect(wrap('en', <PackNotice pack={pack({ mode: 'equal_value', operator: { wallet: wallet(7), isHouse: false } })} />)).toContain('One transaction');
    expect(wrap('de', <PackNotice pack={pack({ operator: { wallet: wallet(7), isHouse: false }, operatorRecord: null })} />)).toContain('noch keine Lieferbilanz');
  });
});

describe('the pack and the card', () => {
  it('the pack is one labelled image of a booster: wrapper art, ribbon with the set name, tier symbols, barcode strip, a tearable top seal, a colour family from the rarest tier', () => {
    const odds = [{ tier: 'a', bps: 7000 }, { tier: 'b', bps: 2800 }, { tier: 'c', bps: 200 }];
    for (const [locale, label, booster] of [['en', 'Booster pack Starter, sealed. 6 cards', 'Booster pack'], ['de', 'Booster-Pack Starter, versiegelt. 6 Karten', 'Booster-Pack']] as const) {
      const html = wrap(locale, <PackArt name="Starter" seed="abc" tag="House" odds={odds} count={6} />);
      expect(html).toContain('role="img"');
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(booster);
      expect(html).toContain('Starter');
      expect(html).toContain('House');
      expect(html).toContain('data-rarity="legendary"');
      expect(html).toContain('data-family="crimson"');
      expect(html).toContain('pk-pack-lid'); // the part that tears open
      expect(html).toContain('feTurbulence'); // wrinkles and grain, inline
      expect((html.match(/<svg[^>]*data-rarity=/g) ?? []).length).toBe(3); // one tier symbol per look
      expect(html).not.toMatch(/<image|<img|url\(['"]?https?:/); // no asset, nothing external
    }
    expect(wrap('en', <PackArt name="x" seed="abc" odds={[{ tier: 'a', bps: 10000 }]} />)).toContain('data-family="emerald"');
    expect(wrap('en', <PackArt name="x" seed="abc" odds={[{ tier: 'a', bps: 9000 }, { tier: 'b', bps: 1000 }]} />)).toContain('data-family="violet"');
  });
  it('every pack of the page draws its own gradient ids (two packs with different colours never share one)', () => {
    const html = wrap('en', <><PackArt name="a" seed="1" odds={[{ tier: 'a', bps: 10000 }]} /><PackArt name="b" seed="2" odds={[{ tier: 'a', bps: 10000 }]} /></>);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('the accent is the look of the rarest published tier', () => {
    expect(accentOf(pack().odds)).toBe('legendary');
    expect(accentOf([{ tier: 'only', bps: 10000 }])).toBe('common');
  });
  it('the card has a back and a front with its holographic layers; flipped is a data attribute the CSS reads', () => {
    const down = renderToStaticMarkup(<HoloCard name="Card A" imageUrl="https://example.com/a.png" rarity="rare" flipped={false} />);
    const up = renderToStaticMarkup(<HoloCard name="Card A" imageUrl={null} rarity="legendary" flipped />);
    expect(down).toContain('data-flipped="false"');
    expect(up).toContain('data-flipped="true"');
    expect(down).toContain('pk-holo');
    expect(down).toContain('alt="Card A"');
    expect(up).toContain('role="img"'); // no image: the name stands in, still announced
  });
});

describe('pay-first screens', () => {
  const draw = (status: string, over: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-0000000000aa', packId: '7b1c2d3e-4f50-4a61-8b72-000000000020', drawIndex: null, status, cluster: 'devnet', buyer: wallet(5), clientSeed: 'a'.repeat(32), poolHash: 'ab'.repeat(32),
    vrf: { requestId: null, status: null, input: null, proofHex: null, outputHex: null }, tier: null, card: null, price: '5000000', settlementRef: null, txSignature: null, createdAt: '2026-10-05T12:00:00.000Z', settledAt: null, flow: 'pay_first', ...over,
  }) as unknown as import('@/contracts').PackDrawView;
  it('shows the four steps and marks the one the purchase is in, in both languages', () => {
    const en = wrap('en', <PayProgress draw={draw('confirming')} />);
    expect(en).toContain('data-testid="pay-progress"');
    expect(en).toContain('data-step="confirm"');
    expect(en).toMatch(/Pay<\/li><li[^>]*data-state="done"|data-state="done"[^>]*>Pay/);
    expect(en).toContain('aria-current="step"');
    expect(wrap('de', <PayProgress draw={draw('delivering')} />)).toContain('Liefern');
    expect(wrap('en', <PayProgress draw={draw('drawn', { operator: { wallet: wallet(1), isHouse: false } })} />)).toContain('data-step="deliver"'); // a third-party draw waits for its operator
    expect(wrap('en', <PayProgress draw={draw('settled')} />)).toContain('data-step="done"');
  });
  it('says the sale was not delivered, why, who the operator is and where the payment and the proof are; it never says money was returned and shows no card', () => {
    const html = wrap('en', <Undelivered draw={draw('undelivered', { undeliveredReason: 'deadline', operator: { wallet: wallet(7), isHouse: false }, txSignature: '4'.repeat(88), vrf: { requestId: '00000000-0000-4000-8000-0000000000bb', status: 'revealed', input: 'x', proofHex: null, outputHex: null } })} onBack={() => undefined} />);
    expect(html).toContain('Not delivered');
    expect(html).toContain('never held your payment');
    expect(html).toContain('delivery deadline passed');
    expect(html).toContain('data-testid="undelivered-operator"');
    expect(html).toContain(`https://explorer.solana.com/address/${wallet(7)}?cluster=devnet`);
    expect(html).toContain(`https://explorer.solana.com/tx/${'4'.repeat(88)}?cluster=devnet`);
    expect(html).toContain('Proof of the draw');
    expect(html).not.toMatch(/was returned/i);
    expect(html).not.toContain('data-testid="revealed"');
    const de = wrap('de', <Undelivered draw={draw('undelivered', { undeliveredReason: 'asset_moved' })} onBack={() => undefined} />);
    expect(de).toContain('Nicht geliefert');
    expect(de).toContain('aus seiner Wallet bewegt');
  });
});
