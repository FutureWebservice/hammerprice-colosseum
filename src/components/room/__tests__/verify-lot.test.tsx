/**
 * The /verify page in every state, rendered to static markup with the real DE and EN messages (no DOM library is installed):
 * the three rows (recomputed here, reported by our server, memo read from the chain) and the four honest verdicts.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('../room.css', () => ({}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import enSettlement from '@/locales/en/settlement.json';
import deSettlement from '@/locales/de/settlement.json';
import enGlossary from '@/locales/en/glossary.json';
import deGlossary from '@/locales/de/glossary.json';
import enTour from '@/locales/en/tour.json';
import enRooms from '@/locales/en/rooms.json';
import deRooms from '@/locales/de/rooms.json';
import deTour from '@/locales/de/tour.json';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { readFacts, type ChainState, type ParsedTx } from '@/lib/verify/chain';
import { VerifyData, verifyAll, type Verified } from '../verifyData';
import { VerifyView, type ChainView } from '../VerifyLot';
import bidsFixture from '@/lib/verify/__tests__/fixtures/devnet-lot-bids.json';
import txFixture from '@/lib/verify/__tests__/fixtures/devnet-settlement-tx.json';

const MESSAGES = { en: { settlement: enSettlement, glossary: enGlossary, tour: enTour, rooms: enRooms }, de: { settlement: deSettlement, glossary: deGlossary, tour: deTour, rooms: deRooms } };
const DEVNET_MINT = '2J9jiJYT6NGbwrf2kUthFXwo16B7W1GzpxxF9Kgf8bix';
const HASH = '04eed183147f346f9dc3e3faee1d6b29dcdff2f090243a1c9a921e75044b53ee';
const SIG = 'jNzE8GsVPwVKhyTXmEyqymPFmzj4oR72r2P3CoAWP2WTKJo4Axq9Y9hECQjCePHZRddSSs8Bphfehn5e89j4eGL';

const data = VerifyData.parse(JSON.parse(JSON.stringify(bidsFixture)));
const tx = txFixture as unknown as ParsedTx;
const facts = (cluster: 'devnet' | 'mainnet-beta' = 'devnet', mint = DEVNET_MINT) => readFacts(tx, cluster, mint);

async function render(chain: ChainView, over: { locale?: 'en' | 'de'; deployment?: Parameters<typeof VerifyView>[0]['deployment']; data?: VerifyData; result?: Verified } = {}) {
  const d = over.data ?? data;
  const result = over.result ?? (await verifyAll(d));
  const locale = over.locale ?? 'en';
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <VerifyView data={d} result={result} chain={chain} locale={locale} deployment={over.deployment ?? { cluster: 'devnet', usdcMint: DEVNET_MINT }} onRetry={() => {}} />
    </NextIntlClientProvider>,
  );
}
const testId = (m: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m)?.[1] ?? null;
const state = (m: string) => /data-testid="verify-result" data-state="([a-z_]+)"/.exec(m)?.[1];
const has = (m: string, id: string) => m.includes(`data-testid="${id}"`);

describe('the three rows', () => {
  it('confirmed: recomputed, server and chain memo are the same hash, each row is marked', async () => {
    const m = await render({ kind: 'confirmed', facts: facts() });
    expect(testId(m, 'verify-recomputed')).toBe(HASH);
    expect(testId(m, 'verify-api')).toBe(HASH);
    expect(testId(m, 'verify-onchain')).toBe(HASH);
    expect(state(m)).toBe('confirmed');
    expect((m.match(/data-mark="ok"/g) ?? []).length).toBe(2);
    expect(m).toContain('Confirmed. The proof stored in the finalized payment transaction matches these bids.');
  });

  it('contradicts: the chain value and the recomputed value are both on the page, the chain row has the cross', async () => {
    const other = 'e'.repeat(64);
    const result = { ...(await verifyAll(data)), recomputed: other, match: false };
    const m = await render({ kind: 'contradicts', why: 'hash', facts: facts() }, { result });
    expect(testId(m, 'verify-recomputed')).toBe(other);
    expect(testId(m, 'verify-onchain')).toBe(HASH);
    expect(state(m)).toBe('contradicts');
    expect(m).toContain('data-mark="bad"');
    expect(m).toContain('Does not match.');
  });

  it('contradicts (settlement): both settlement ids are named', async () => {
    const m = await render({ kind: 'contradicts', why: 'settlement', facts: facts() });
    expect(m).toContain('d22dba70-68cc-4861-95a1-b382323f3c3f'); // the memo's and ours here, from the fixture
    expect(state(m)).toBe('contradicts');
  });

  it('contradicts (memo): no memo hash is shown and the row says none was found', async () => {
    const noMemo = { ...facts(), memo: { kind: 'none' } as const };
    const m = await render({ kind: 'contradicts', why: 'memo', facts: noMemo });
    expect(has(m, 'verify-onchain')).toBe(false);
    expect(has(m, 'verify-onchain-none')).toBe(true);
    expect(m).toContain('No valid memo found');
  });

  it.each([
    ['no_signature', 'Nothing to read yet'],
    ['not_finalized', 'Not final yet'],
    ['unknown', 'Not found'],
  ] as const)('not found (%s): the chain row is "not checked", never a cross', async (why, text) => {
    const m = await render({ kind: 'not_found', why });
    expect(state(m)).toBe('not_found');
    expect(m).toContain(text);
    expect(m).toContain('data-mark="none"');
    expect(m).not.toContain('data-mark="bad"');
    expect(has(m, 'verify-onchain')).toBe(false);
    expect(has(m, 'verify-retry')).toBe(why !== 'no_signature');
  });

  it('unreachable: says it could not check and that this says nothing about the bids; offers a retry', async () => {
    const m = await render({ kind: 'unreachable' });
    expect(state(m)).toBe('unreachable');
    expect(m).toContain('says nothing about the bids');
    expect(m).not.toContain('data-mark="bad"');
    expect(has(m, 'verify-retry')).toBe(true);
  });

  it('while the chain is being read the page says so and does not claim "on chain"', async () => {
    const m = await render('checking');
    expect(state(m)).toBe('checking');
    expect(m).toContain('Reading the payment from the network');
    expect(m).not.toContain('Confirmed');
  });

  it('a lot without a settlement compares nothing and shows no chain rows', async () => {
    const m = await render(null, { data: { ...data, settlement: null } });
    expect(state(m)).toBe('no_settlement');
    expect(has(m, 'verify-api')).toBe(false);
    expect(has(m, 'verify-onchain')).toBe(false);
  });

  it('the bids table still shows every signature check', async () => {
    const m = await render({ kind: 'confirmed', facts: facts() });
    expect((m.match(/data-check="valid"/g) ?? []).length).toBe(4);
    // Bids are stored in base units (6 decimals); the table shows USDC, not 60000000.
    expect(m).toContain('>60 USDC</td>');
    expect(m).toContain('>78 USDC</td>');
    expect(m).toContain('data-label="Amount"'); // the phone layout labels every cell
    expect(m).not.toContain('60000000');
  });
});

describe('what the network shows (devnet)', () => {
  it('signature, slot, finalized, signers and both transfers come from the transaction', async () => {
    const m = await render({ kind: 'confirmed', facts: facts() });
    expect(testId(m, 'verify-signature')).toBe(SIG);
    expect(testId(m, 'verify-slot')).toBe('506651369');
    expect(testId(m, 'verify-commitment')).toContain('Finalized');
    expect(testId(m, 'verify-network')).toContain('Devnet');
    expect((m.match(/<li data-role="/g) ?? []).length).toBe(3);
    for (const role of ['fee_payer', 'buyer', 'seller']) expect(m).toContain(`data-role="${role}"`);
    expect(m).toContain('76.05 USDC');
    expect(m).toContain('1.95 USDC');
    expect(has(m, 'verify-move-card')).toBe(true);
    expect(testId(m, 'verify-memo-text')).toBe(`hp:settle:d22dba70-68cc-4861-95a1-b382323f3c3f:${HASH}`);
  });

  it('the explorer link points to the devnet cluster', async () => {
    const m = await render({ kind: 'confirmed', facts: facts() });
    expect(m).toContain(`href="https://explorer.solana.com/tx/${SIG}?cluster=devnet"`);
  });

  it('the page is complete in German as well', async () => {
    const m = await render({ kind: 'confirmed', facts: facts() }, { locale: 'de' });
    expect(m).toContain('Bestätigt. Der Nachweis in der finalisierten Zahlungstransaktion');
    expect(m).toContain('Was das Netzwerk zeigt');
    expect(m).toContain('Zahler der Netzwerkgebühr');
    expect(m).toContain('76.05 USDC');
    const bad = await render({ kind: 'contradicts', why: 'hash', facts: facts() }, { locale: 'de' });
    expect(bad).toContain('Stimmt nicht überein.');
    expect(await render({ kind: 'unreachable' }, { locale: 'de' })).toContain('Prüfung nicht möglich');
  });
});

describe('what the network shows (mainnet configuration)', () => {
  const mainnetData = VerifyData.parse({ ...JSON.parse(JSON.stringify(bidsFixture)), settlement: { ...bidsFixture.settlement, cluster: 'mainnet-beta' } });
  const mainnetTx = JSON.parse(JSON.stringify(txFixture).split(DEVNET_MINT).join(MAINNET_USDC_MINT)) as ParsedTx;

  it('links the mainnet explorer and names the network Mainnet', async () => {
    const chain: ChainState = { kind: 'confirmed', facts: readFacts(mainnetTx, 'mainnet-beta', MAINNET_USDC_MINT) };
    const m = await render(chain, { data: mainnetData, deployment: { cluster: 'mainnet-beta' } });
    expect(m).toContain(`href="https://explorer.solana.com/tx/${SIG}"`);
    expect(m).not.toContain('cluster=devnet');
    expect(testId(m, 'verify-network')).toBe('Mainnet');
    expect(m).toContain('76.05 USDC');
  });

  it('an unknown token is named by its mint, not called USDC', async () => {
    const chain: ChainState = { kind: 'confirmed', facts: readFacts(mainnetTx, 'mainnet-beta', DEVNET_MINT) };
    const m = await render(chain, { data: mainnetData, deployment: { cluster: 'mainnet-beta' } });
    expect(m).not.toContain('76.05 USDC');
    expect(m).toContain('76.05 of token EPjF…Dt1v');
  });
});

describe('wording', () => {
  it('the lede only says it reads the network when the lot has been paid, and never says "on chain" by itself', () => {
    for (const msgs of [enSettlement, deSettlement]) {
      const lede = msgs.verify.lede;
      expect(lede).not.toMatch(/on[- ]?chain/i);
      expect(JSON.stringify(msgs.verify)).not.toContain('\u2014');
      expect(JSON.stringify(msgs.verify)).not.toContain('–');
    }
  });
  it('no promise of prevention or proof of honesty in either language', () => {
    const all = JSON.stringify([enSettlement.verify, deSettlement.verify]).toLowerCase();
    for (const bad of ['shill', 'prevent', 'beweis', 'verhindert', 'guarantee', 'garantie']) expect(all).not.toContain(bad);
  });
  it('DE and EN have the same keys', () => {
    const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p]);
    expect(keys(deSettlement.verify).sort()).toEqual(keys(enSettlement.verify).sort());
  });
});

describe('the demo label on the verify page of a house lot', () => {
  const house = (isHouse: boolean) => VerifyData.parse({ ...JSON.parse(JSON.stringify(bidsFixture)), lot: { ...data.lot, isHouse } });
  it('says DEMO and what is demo for a lot of the house room, in both languages', async () => {
    const en = await render(null, { data: house(true) });
    expect(has(en, 'demo-badge')).toBe(true);
    expect(en).toContain('Tutorial: practise bidding here.');
    expect(en).toContain('The labelled bots never outbid a person.');
    expect(en.match(/<p class="hp-demo-note".*?<\/p>/)?.[0]).not.toMatch(/test USDC|replica/i); // the lot's own name may say replica
    const de = await render(null, { data: house(true), locale: 'de' });
    expect(has(de, 'demo-badge')).toBe(true);
    expect(de).toContain('Tutorial: Hier können Sie das Bieten üben.');
    expect(de.match(/<p class="hp-demo-note".*?<\/p>/)?.[0]).not.toMatch(/Test-USDC|Replik/i);
  });
  it('says nothing of the kind for a seller lot or an older answer without the flag', async () => {
    expect(has(await render(null, { data: house(false) }), 'demo-badge')).toBe(false);
    expect(has(await render(null), 'demo-badge')).toBe(false);
  });
});
