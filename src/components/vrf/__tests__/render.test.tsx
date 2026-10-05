/**
 * The draw UI rendered to static markup with the real DE and EN messages (no DOM library is installed): the proof panel for each state and
 * purpose, the checklist for each check status, the key card, the chip's initial states, and the cluster wording.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('../vrf.css', () => ({}));
vi.mock('@/components/vrf/vrf.css', () => ({}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import enVrf from '@/locales/en/vrf.json';
import deVrf from '@/locales/de/vrf.json';
import type { Check, VrfRequestView } from '@/lib/vrf';
import { makeWorld } from '@/lib/vrf/__tests__/testkit';
import FairnessChip from '@/components/room/slots/FairnessChip';
import Checklist from '../Checklist';
import KeyCard from '../KeyCard';
import ProofPanel from '../ProofPanel';
import RecomputeButton from '../RecomputeButton';
import LotOrderProof, { cardDraws } from '../LotOrderProof';
import { useVrfT } from '../text';

const MESSAGES = { en: { vrf: enVrf }, de: { vrf: deVrf } };
const wrap = (locale: 'en' | 'de', node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">{node}</NextIntlClientProvider>);
const SHOW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REQ = '1a2b3c4d-2222-4333-8444-5555abcdef55';

function Panel({ view, names = {} }: { view: VrfRequestView; names?: Record<string, string> }) { const t = useVrfT(view.cluster); return <ProofPanel view={view} names={names} t={t} />; }
function List({ checks, cluster = 'devnet' as const }: { checks: Check[]; cluster?: 'devnet' | 'mainnet-beta' }) { const t = useVrfT(cluster); return <Checklist checks={checks} t={t} />; }
function Btn(p: { running: boolean; done: boolean }) { const t = useVrfT(); return <RecomputeButton {...p} onRun={() => {}} t={t} />; }
function Key({ view, info }: { view: VrfRequestView; info: React.ComponentProps<typeof KeyCard>['info'] }) { const t = useVrfT(view.cluster); return <KeyCard publicKey={view.publicKey} cluster={view.cluster} info={info} t={t} />; }

const testId = (m: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m)?.[1] ?? null;
const lots = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`00000000-0000-4000-8000-00000000000${i + 1}`, `Card number ${i + 1}`]));

describe('the proof panel', () => {
  for (const locale of ['en', 'de'] as const) {
    it(`${locale}: a revealed lot order shows key data, input, beacon, proof, output, both transactions and the order before and after`, () => {
      const { view } = makeWorld('devnet', 'lot_order');
      const m = wrap(locale, <Panel view={view} names={lots} />);
      expect(testId(m, 'vrf-proof-hex')).toBe(view.proofHex);
      expect(testId(m, 'vrf-output-hex')).toBe(view.outputHex);
      expect(testId(m, 'vrf-beacon')).toContain(String(view.beacon!.slot));
      expect(m).toContain('hammerprice vrf v1');
      expect(m).toContain(`/tx/${view.commitTx}?cluster=devnet`);
      expect(m).toContain(`/tx/${view.revealTx}?cluster=devnet`);
      expect(m).toContain('Card number 1');
      expect(m).toContain('data-testid="vrf-order-before"');
      expect(m).toContain('data-testid="vrf-order-after"');
      expect(m).not.toMatch(/\u2014/);
    });
  }

  it('a raffle shows the winner and the entrants, not an order', () => {
    const { view } = makeWorld('devnet', 'raffle');
    const m = wrap('en', <Panel view={view} />);
    expect(m).toContain('data-testid="vrf-raffle"');
    expect(testId(m, 'vrf-winner')).toMatch(/^Drawn: paddle \d+$/);
    expect(m).not.toContain('vrf-order-before');
    expect(wrap('de', <Panel view={view} />)).toMatch(/Gezogen: Bieternummer \d+/);
  });

  it('a draw that is not revealed shows what exists and "not available yet" for the rest', () => {
    const { view } = makeWorld();
    const pending: VrfRequestView = { ...view, status: 'pending', alphaText: null, beacon: null, commitTx: null, commitSlot: null, proofHex: null, outputHex: null, revealTx: null, result: null };
    const m = wrap('en', <Panel view={pending} />);
    expect(m).toContain('not available yet');
    expect(testId(m, 'vrf-status')).toBe('Started, waiting for the commit on the network');
    expect(m).not.toContain('vrf-proof-hex');
  });

  it('a lot order that was recorded but not applied says so', () => {
    const { view } = makeWorld();
    const m = wrap('en', <Panel view={{ ...view, result: { ...(view.result as object), applied: false } }} />);
    expect(testId(m, 'vrf-applied')).toMatch(/only recorded/);
  });

  it('mainnet: the explorer links carry no cluster parameter and the network is named', () => {
    const { view } = makeWorld('mainnet-beta');
    const m = wrap('en', <Panel view={view} />);
    expect(m).toContain(`/tx/${view.commitTx}"`);
    expect(m).not.toContain('cluster=devnet');
    expect(m).toContain('Solana mainnet');
    expect(wrap('en', <Panel view={makeWorld('devnet').view} />)).toContain('Solana devnet');
  });
});

describe('the checklist', () => {
  const mk = (status: Check['status'], id: Check['id'] = 'proof', kind: Check['kind'] = 'crypto', detail?: string): Check => ({ id, kind, status, ...(detail ? { detail } : {}) });
  it('marks pass, fail, skipped and unverifiable with a word AND a mark, and groups browser checks apart from network checks', () => {
    const m = wrap('en', <List checks={[mk('pass', 'params_hash'), mk('fail', 'proof', 'crypto', 'proof does not verify'), mk('skipped', 'commit_memo', 'chain'), mk('unverifiable', 'beacon', 'chain')]} />);
    expect(m).toMatch(/data-testid="vrf-check-params_hash" data-status="pass"/);
    expect(m).toContain('✓ </span>matches');
    expect(m).toContain('✗ </span>does not match');
    expect(m).toContain('– </span>nothing to check yet');
    expect(m).toContain('? </span>could not be checked');
    expect(m).toContain('proof does not verify'); // the detail of a failure is shown
    expect(m.indexOf('Checked in your browser')).toBeLessThan(m.indexOf('Read from the network'));
  });
  it('shows no detail for a pass, and a German page is fully German', () => {
    const m = wrap('de', <List checks={[mk('pass', 'result', 'crypto', 'internal note')]} />);
    expect(m).not.toContain('internal note');
    expect(m).toContain('stimmt');
    expect(m).toContain('In Ihrem Browser geprüft');
  });
});

describe('the recompute button and the key card', () => {
  it('says "Selbst nachrechnen" in German, switches to running and again', () => {
    expect(wrap('de', <Btn running={false} done={false} />)).toContain('Selbst nachrechnen');
    expect(wrap('en', <Btn running done={false} />)).toMatch(/Recomputing.*disabled|disabled.*Recomputing/s);
    expect(wrap('en', <Btn running={false} done />)).toContain('Recompute again');
  });
  it('shows the public key, its explorer link, the counters and the announcement; says so when there is none', () => {
    const { view, publicKey } = makeWorld();
    const info = { publicKey, suite: 'ECVRF-EDWARDS25519-SHA512-TAI' as const, cluster: 'devnet' as const, registrationTx: '5'.repeat(88), stats: { commits: 4, reveals: 3, defaults: 1 } };
    const m = wrap('en', <Key view={view} info={info} />);
    expect(testId(m, 'vrf-public-key')).toBe(publicKey);
    expect(m).toContain('data-testid="vrf-copy"');
    expect(m).toContain(`/address/${publicKey}?cluster=devnet`);
    expect(testId(m, 'vrf-stats')).toBe('Commits 4, reveals 3, not completed 1');
    expect(m).toContain('/tx/' + '5'.repeat(88));
    expect(wrap('en', <Key view={view} info={{ ...info, registrationTx: null }} />)).toContain('No announcement transaction');
    expect(wrap('en', <Key view={view} info={null} />)).not.toContain('vrf-stats'); // the counters are not shown for a key they do not belong to
    expect(wrap('en', <Key view={view} info={{ ...info, publicKey: 'other' }} />)).not.toContain('vrf-stats');
  });
});

describe('the fairness chip', () => {
  const chip = (locale: 'en' | 'de', order: React.ComponentProps<typeof FairnessChip>['order']) => wrap(locale, <FairnessChip showId={SHOW} order={order} />);
  it('is empty for a catalogue show and for a drawn order without a request', () => {
    expect(chip('en', { mode: 'catalogue' })).toBe('');
    expect(chip('en', { mode: 'vrf' })).toBe('');
  });
  it('pending and committed: "is being drawn" with the 45 second note, no link yet', () => {
    for (const status of ['pending', 'committed'] as const) {
      const m = chip('en', { mode: 'vrf', status, requestId: REQ });
      expect(m).toContain('data-state="pending"');
      expect(m).toContain('The lot order is being drawn (about 45 seconds)');
      expect(m).not.toContain('fairness-link');
    }
    expect(chip('de', { mode: 'vrf', status: 'pending', requestId: REQ })).toContain('Die Reihenfolge der Lose wird ausgelost (etwa 45 Sekunden)');
  });
  it('revealed: not "proven" until the browser has recomputed it (the first render says it is checking), with the proof link in the locale', () => {
    const m = chip('de', { mode: 'vrf', status: 'revealed', requestId: REQ });
    expect(m).toContain('data-state="checking"');
    expect(m).not.toContain('Reihenfolge per Zufallsbeweis'); // the green sentence needs the local result
    expect(m).toContain(`href="/de/verify/random/${REQ}"`);
  });
  it('defaulted: the catalogue order, with a link to the explanation', () => {
    const m = chip('en', { mode: 'vrf', status: 'defaulted', requestId: REQ });
    expect(m).toContain('data-state="defaulted"');
    expect(m).toContain('Catalogue order');
  });
});

describe('the lot page card', () => {
  it('renders nothing before it knows there is a draw (the data arrives after mount)', () => {
    expect(wrap('en', <LotOrderProof showId={SHOW} locale="en" />)).toBe('');
  });
});

describe('the lot page card shows only a draw that can be recomputed', () => {
  const d = (status: string) => ({ lotOrder: { requestId: REQ, status }, raffle: { requestId: REQ, status } });
  it('pending, committed and defaulted draws give no card', () => {
    for (const s of ['pending', 'committed', 'defaulted']) expect(cardDraws(d(s))).toEqual({ order: null, raffle: null });
  });
  it('a revealed draw gives the card, nothing gives none', () => {
    expect(cardDraws(d('revealed')).order?.requestId).toBe(REQ);
    expect(cardDraws(null)).toEqual({ order: null, raffle: null });
  });
});

describe('the verdict wording is no stronger than the checks', () => {
  it('no headline says "proven" or "bewiesen" without a qualifier, in either language', () => {
    expect(enVrf.verdict.proven).not.toMatch(/^Proven/);
    expect(deVrf.verdict.proven).not.toMatch(/^Bewiesen/);
    expect(enVrf.verdict.proven).toMatch(/best effort/);
  });
});

describe('copy', () => {
  const strings = (o: unknown, out: string[] = []): string[] => { if (typeof o === 'string') out.push(o); else if (o && typeof o === 'object') Object.values(o).forEach((v) => strings(v, out)); return out; };
  it('never claims a rank, a win or open source, and has no em dash', () => {
    for (const s of [...strings(enVrf), ...strings(deVrf)]) {
      expect(s).not.toMatch(/\u2014/);
      expect(s).not.toMatch(/open[- ]source|gewonnen|won the|winner of/i);
    }
  });
  it('the German texts address the reader as Sie and the mainnet sibling of the beacon text exists where a text names devnet', () => {
    expect(deVrf.explain.beaconMain).toBeTruthy();
    expect(enVrf.explain.beaconMain).toBeTruthy();
    expect(enVrf.explain.beacon).toMatch(/devnet/);
    expect(enVrf.explain.beaconMain).not.toMatch(/test/);
    expect(deVrf.explain.beaconMain).not.toMatch(/Test/);
  });
});
