/**
 * The words of the packs: German and English complete and alike, in the house style, with the network's wording where a text talks about test
 * money, and no claim the build cannot back.
 */
import { describe, expect, it } from 'vitest';
import de from '@/locales/de/packs.json';
import en from '@/locales/en/packs.json';

type Tree = { [k: string]: string | Tree };
const leaves = (tree: Tree, prefix = ''): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === 'string') out.set(prefix + k, v);
    else for (const [k2, v2] of leaves(v, `${prefix}${k}.`)) out.set(k2, v2);
  }
  return out;
};
const D = leaves(de as Tree), E = leaves(en as Tree);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort().join(',');

describe('packs copy', () => {
  it('has the same keys in German and English', () => {
    expect([...D.keys()].filter((k) => !E.has(k))).toEqual([]);
    expect([...E.keys()].filter((k) => !D.has(k))).toEqual([]);
    expect(D.size).toBeGreaterThan(150);
  });
  it('uses the same placeholders in both languages', () => {
    for (const [k, v] of D) expect(placeholders(v), k).toBe(placeholders(E.get(k) ?? ''));
  });
  it('has no empty text and no em dash, and the German is formal (Sie)', () => {
    for (const map of [D, E]) for (const [k, v] of map) { expect(v.trim(), k).not.toBe(''); expect(v, k).not.toMatch(/\u2014/); }
    for (const [k, v] of D) expect(v, k).not.toMatch(/\b(du|dein|deine|deiner|dir|dich)\b/i);
  });
  it('makes no promise the build cannot keep: no guarantee, no jackpot, no luck, no "win"', () => {
    for (const [k, v] of E) expect(v, k).not.toMatch(/guarantee|jackpot|\blucky\b|\bwin(s|ning|nings)?\b|risk-free|open.source/i);
    for (const [k, v] of D) expect(v, k).not.toMatch(/garantiert|garantie|jackpot|gl[üu]ck|gewinn|risikofrei|open.source/i);
  });
  it('never names the ideathon, a rank or an AI', () => {
    for (const map of [D, E]) for (const [k, v] of map) expect(v, k).not.toMatch(/ideathon|colosseum|\bKI\b|\bAI\b/i);
  });
  it('every text about test money, the test network or replicas has a "Main" sibling for mainnet, and no "Main" text still says test', () => {
    for (const map of [D, E]) {
      for (const [k, v] of map) {
        if (k.endsWith('Main')) {
          expect(map.has(k.slice(0, -4)), `${k} has a base text`).toBe(true);
          expect(v, k).not.toMatch(/test|replica|replik|devnet/i);
        } else if (/test|replica|replik|devnet/i.test(v)) {
          expect(map.has(`${k}Main`), `${k} talks about test money and needs a ${k}Main sibling`).toBe(true);
        }
      }
    }
  });
  it('the compact notice says the things the law needs: 18+, who the counterparty is, the delivery deadline, no custody, public odds', () => {
    expect(E.get('buy.age')).toMatch(/18/);
    expect(D.get('buy.age')).toMatch(/18/);
    for (const k of ['house', 'chance', 'equal']) { expect(E.get(`notice.${k}`), k).toMatch(/18\+/); expect(D.get(`notice.${k}`), k).toMatch(/Ab 18/); expect(E.get(`notice.${k}`), k).toMatch(/Odds and pool are public/); expect(D.get(`notice.${k}`), k).toMatch(/Quoten und Pool sind öffentlich/); }
    expect(E.get('notice.chance')).toMatch(/counterparty is the seller/);
    expect(E.get('notice.chance')).toMatch(/within 24 hours/);
    expect(E.get('notice.chance')).toMatch(/never holds your payment/);
    expect(E.get('notice.chance')).toMatch(/cannot refund you/);
    expect(D.get('notice.chance')).toMatch(/Vertragspartner ist der Verkäufer/);
    expect(D.get('notice.chance')).toMatch(/24 Stunden/);
    expect(D.get('notice.chance')).toMatch(/nie hält/);
    expect(D.get('notice.chance')).toMatch(/nichts erstatten/);
    expect(E.get('notice.equal')).toMatch(/payment goes to the seller/);
    expect(E.get('notice.house')).toMatch(/Hammerprice \(demo pack/);
  });
  it('the proof limits are honest: the card is fixed before signing, and the proof does not show the operator\'s wallet', () => {
    expect(E.get('proof.limit4')).toMatch(/already fixed/i);
    expect(D.get('proof.limit4')).toMatch(/steht die Karte bereits fest/i);
    expect(E.get('proof.limit5')).toMatch(/not the operator's wallet/i);
    expect(D.get('proof.limit5')).toMatch(/nicht die Wallet des Anbieters/);
  });
  it('has a text for every state of a pay-first purchase, for the not-delivered screen and for every reason, and no text about a refund by the platform', () => {
    for (const k of ['confirming', 'drawAfter', 'drawn', 'waitingDelivery', 'delivering', 'delivered', 'toHouse', 'cardNone']) { expect(E.has(`step.${k}`), k).toBe(true); expect(D.has(`step.${k}`), k).toBe(true); }
    for (const k of ['pay', 'confirm', 'draw', 'deliver', 'title']) { expect(E.has(`progress.${k}`), k).toBe(true); expect(D.has(`progress.${k}`), k).toBe(true); }
    for (const k of ['deadline', 'asset_moved', 'asset_not_transferable', 'pool_empty']) { expect(E.has(`undelivered.reason.${k}`), k).toBe(true); expect(D.has(`undelivered.reason.${k}`), k).toBe(true); }
    for (const k of ['pending', 'undelivered', 'delivering', 'expired']) expect(E.has(`log.${k}`), k).toBe(true);
    expect(E.get('undelivered.body')).toMatch(/never held your payment/i);
    expect(D.get('undelivered.body')).toMatch(/nie gehalten/);
    for (const map of [E, D]) for (const k of map.keys()) expect(k, 'a platform refund has no text').not.toMatch(/^refund\.|refunding|refunded/);
  });
  it('third parties are told what a chance pack asks of them: deliver in time, or strike and pause', () => {
    expect(E.get('manage.chanceNote')).toMatch(/strike/);
    expect(E.get('manage.chanceNote')).toMatch(/paused/);
    expect(D.get('manage.chanceNote')).toMatch(/Verwarnung/);
    expect(E.get('manage.lede')).toMatch(/Chance|chance pack/);
    for (const k of ['deliveries', 'deliveriesNone', 'deliveryItem', 'deliverLate', 'deliver', 'delivered', 'deliverNote']) { expect(E.has(`manage.${k}`), k).toBe(true); expect(D.has(`manage.${k}`), k).toBe(true); }
  });
  it('the verify page text no longer claims nobody could choose a different result: it says a void draw is marked, struck and not refunded', () => {
    for (const [k, v] of E) expect(v, k).not.toMatch(/nobody could choose a different result/i);
    expect(E.get('proof.limit1')).toMatch(/does not show that the operator delivers/i);
    expect(E.get('proof.limit5')).toMatch(/cannot refund the buyer/i);
    expect(D.get('proof.limit5')).toMatch(/nichts erstatten/);
    expect(E.get('proof.limit5')).toMatch(/not the operator's wallet/i);
  });
  it('every tier look and every proof rule has its text', () => {
    for (const k of ['common', 'uncommon', 'rare', 'epic', 'legendary']) expect(E.has(`tier.${k}`), k).toBe(true);
    for (const k of ['pool_hash', 'params', 'alpha', 'proof', 'output', 'result', 'taken', 'beacon', 'payment', 'order']) { expect(E.has(`proof.rule.${k}`), k).toBe(true); expect(E.has(`proof.rule.${k}_d`), k).toBe(true); }
  });
});
