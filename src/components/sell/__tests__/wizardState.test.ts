import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CreateShowRequest, type SellAsset } from '@/contracts/api';
import {
  DEFAULT_INCREMENT, DEFAULT_OPENING, MAX_LOTS, STEPS, TITLE_RE, allReady, applyAssets, autoTitle, buildCreateRequest, canLeave, canPublish,
  firstTermIssue, initialState, isChecking, lotIssues, markChecking, markError, setAllTerms, setTerm, sharedTerm, showIssues, termsValid, titleIssue,
  togglePick, withTitle, setDescription, setLotDuration, lotDurationOf, LOT_DURATION_PRESETS_S, DEFAULT_LOT_DURATION_S, type WizardState,
} from '../wizardState';

process.env.TZ = 'Europe/Berlin';
const NOW = new Date('2026-10-05T10:00:00Z');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../../contracts/fixtures', `${name}.json`), 'utf8'));
const ASSETS: SellAsset[] = fixture('sell-assets').assets;
const [CORE, PNFT] = ASSETS;
const base58 = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789';
const mint = (i: number) => (base58.repeat(2) + base58).slice(i, i + 44).padEnd(44, '1');
const core = (i: number): SellAsset => ({ ...CORE, mint: mint(i), name: `Card ${i}` });

function withLots(n: number): WizardState {
  let s = initialState(NOW);
  for (let i = 0; i < n; i++) s = togglePick(s, core(i));
  return s;
}
/** A state that may publish: one valid lot, a title, a start in the future, readiness ready. */
function publishable(): WizardState {
  let s = togglePick(initialState(NOW), CORE);
  s = { ...s, title: 'Saturday night slabs', when: 'schedule', start: '2026-10-06T20:00' };
  return applyAssets(s, ASSETS);
}

describe('picking cards', () => {
  it('starts with no cards, the first step, "start now" and a suggested time in case the seller schedules', () => {
    const s = initialState(NOW);
    expect(s.step).toBe('pick');
    expect(s.when).toBe('now');
    expect(s.lots).toEqual([]);
    expect(s.start).toBe('2026-10-05T13:00'); // 12:00 Berlin + 1 h
  });

  it('adds an eligible card with the default terms and toggles it off again', () => {
    let s = togglePick(initialState(NOW), CORE);
    expect(s.lots).toHaveLength(1);
    expect(s.lots[0]).toMatchObject({ mint: CORE.mint, reserve: '', opening: DEFAULT_OPENING, increment: DEFAULT_INCREMENT });
    expect(s.readiness[CORE.mint]).toEqual({ kind: 'unchecked' });
    s = togglePick(s, CORE);
    expect(s.lots).toEqual([]);
    expect(s.readiness).toEqual({});
  });

  it('refuses a card that is not eligible', () => {
    expect(PNFT.eligible).toBe(false);
    const s = togglePick(initialState(NOW), PNFT);
    expect(s.lots).toEqual([]);
  });

  it('caps the show at 30 lots and still lets a picked card be removed', () => {
    let s = withLots(MAX_LOTS);
    expect(s.lots).toHaveLength(30);
    const extra = core(40);
    expect(togglePick(s, extra).lots).toHaveLength(30);
    s = togglePick(s, core(0));
    expect(s.lots).toHaveLength(29);
    expect(togglePick(s, extra).lots).toHaveLength(30);
  });

  it('keeps the order of picking as the lot order', () => {
    let s = initialState(NOW);
    for (const i of [3, 1, 2]) s = togglePick(s, core(i));
    expect(s.lots.map((l) => l.name)).toEqual(['Card 3', 'Card 1', 'Card 2']);
  });
});

describe('terms validation', () => {
  const lot = (over: Partial<WizardState['lots'][number]> = {}) => ({ ...withLots(1).lots[0], ...over });

  it('defaults are valid and an empty reserve means no reserve', () => {
    expect(lotIssues(lot())).toEqual({});
  });
  it('flags each field on its own', () => {
    expect(lotIssues(lot({ opening: '' }))).toEqual({ opening: 'required' });
    expect(lotIssues(lot({ increment: '0' }))).toEqual({ increment: 'zero' });
    expect(lotIssues(lot({ opening: 'x', increment: '-1' }))).toEqual({ opening: 'invalid', increment: 'invalid' });
    expect(lotIssues(lot({ reserve: '2000000' }))).toEqual({ reserve: 'too_large' });
  });
  it('requires the reserve to be at least the opening price, and allows equal', () => {
    expect(lotIssues(lot({ opening: '10', reserve: '9.99' }))).toEqual({ reserve: 'reserve_below_opening' });
    expect(lotIssues(lot({ opening: '10', reserve: '10' }))).toEqual({});
    expect(lotIssues(lot({ opening: '10', reserve: '10,5' }))).toEqual({});
  });
  it('does not stack a reserve complaint on an unreadable opening price', () => {
    expect(lotIssues(lot({ opening: 'x', reserve: '5' }))).toEqual({ opening: 'invalid' });
  });
  it('termsValid is every lot valid', () => {
    let s = withLots(2);
    expect(termsValid(s)).toBe(true);
    s = setTerm(s, s.lots[1].mint, 'opening', '');
    expect(termsValid(s)).toBe(false);
  });
});

describe('title and start', () => {
  it.each([
    ['', 'required'],
    ['  ', 'required'],
    ['ab', 'too_short'],
    ['a'.repeat(81), 'too_long'],
    ['Night <script>', 'characters'],
    ['Emoji 🔥 night', 'characters'],
  ])('title %j -> %s', (t, issue) => expect(titleIssue(t)).toBe(issue));

  it.each(['Saturday night slabs', 'Späte Schätze #2', "Tom's PSA 10 (rare) & more: half off!", 'Ω-Edition'])('accepts %j', (t) => {
    expect(titleIssue(t)).toBeNull();
  });

  it('uses the same character rule as the contract', () => {
    const contractTitle = CreateShowRequest.shape.title;
    for (const t of ['Night <script>', 'Späte Schätze #2', 'a/b+c', 'x;y', 'tab\there', 'Emoji 🔥 night', 'ok title']) {
      expect(TITLE_RE.test(t.trim()) && t.trim().length >= 3, t).toBe(contractTitle.safeParse(t).success);
    }
  });

  it('reports start problems only when the seller schedules the auction', () => {
    const s: WizardState = { ...initialState(NOW), title: 'Good title', when: 'schedule', start: '2026-10-05T12:01' };
    expect(showIssues(s, NOW)).toEqual({ start: 'too_soon' });
    expect(showIssues({ ...s, start: '' }, NOW)).toEqual({});
    expect(showIssues({ ...s, title: '', start: 'x' }, NOW)).toEqual({ title: 'required', start: 'invalid' });
    expect(showIssues({ ...s, when: 'now', start: 'x' }, NOW)).toEqual({});
  });
});

describe('two visible price fields', () => {
  it('sets one field on every card and reports a shared value only when the cards agree', () => {
    let s = setAllTerms(withLots(3), 'opening', '25');
    expect(s.lots.map((l) => l.opening)).toEqual(['25', '25', '25']);
    expect(sharedTerm(s, 'opening')).toBe('25');
    s = setTerm(s, s.lots[1].mint, 'opening', '30');
    expect(sharedTerm(s, 'opening')).toBeNull();
    expect(sharedTerm(initialState(NOW), 'opening')).toBe('');
  });
  it('shows the first problem any card has with a field', () => {
    let s = withLots(2);
    expect(firstTermIssue(s, 'opening')).toBeNull();
    s = setTerm(s, s.lots[1].mint, 'opening', '0');
    expect(firstTermIssue(s, 'opening')).toBe('zero');
    expect(firstTermIssue(s, 'reserve')).toBeNull();
  });
});

describe('generated title', () => {
  const label = (name: string, n: number) => (n === 1 ? `${name} auction` : `${name} and ${n - 1} more`);
  it('is "<card name> auction" for one card and counts the rest for several', () => {
    expect(autoTitle(withLots(1).lots, label, 'Card auction')).toBe('Card 0 auction');
    expect(autoTitle(withLots(3).lots, label, 'Card auction')).toBe('Card 0 and 2 more');
  });
  it('drops characters the contract refuses, cuts long names and falls back when nothing is left', () => {
    const lot = (name: string) => ({ ...withLots(1).lots[0], name });
    expect(autoTitle([lot('Pikachu <script> ★ PSA 10')], label, 'Card auction')).toBe('Pikachu script PSA 10 auction');
    const long = autoTitle([lot('x'.repeat(200))], label, 'Card auction');
    expect(long.length).toBeLessThanOrEqual(80);
    expect(titleIssue(long)).toBeNull();
    expect(autoTitle([lot('★★★')], label, 'Card auction')).toBe('Card auction');
    expect(autoTitle([], label, 'Card auction')).toBe('Card auction');
  });
  it('every generated title passes the same contract the server checks', () => {
    for (const name of ['Späte Schätze #2', 'Tom\'s PSA 10 (rare) & more', 'Ω-Edition', '🔥🔥 Charizard 🔥🔥']) {
      const t = autoTitle([{ ...withLots(1).lots[0], name }], label, 'Card auction');
      expect(CreateShowRequest.shape.title.safeParse(t).success, t).toBe(true);
    }
  });
  it('withTitle fills the generated title only when the seller typed none', () => {
    const s = withLots(1);
    expect(withTitle(s, label, 'x').title).toBe('Card 0 auction');
    expect(withTitle({ ...s, title: 'Mine' }, label, 'x').title).toBe('Mine');
  });
});

describe('moving between steps', () => {
  it('needs at least one card to leave the first step', () => {
    expect(canLeave(initialState(NOW), 'pick')).toBe(false);
    expect(canLeave(withLots(1), 'pick')).toBe(true);
  });
  it('needs valid prices to leave the price step', () => {
    const s = withLots(1);
    expect(canLeave(s, 'price')).toBe(true);
    expect(canLeave(setTerm(s, s.lots[0].mint, 'increment', 'x'), 'price')).toBe(false);
    expect(canLeave(setTerm(s, s.lots[0].mint, 'opening', ''), 'price')).toBe(false);
  });
  it('has three steps and the last one has no next', () => {
    expect(STEPS).toEqual(['pick', 'price', 'time']);
    expect(canLeave(withLots(1), 'time')).toBe(false);
  });
});

describe('readiness and the Publish gate', () => {
  it('is ready only after a fresh eligible read, never before', () => {
    const s = withLots(1);
    expect(allReady(s)).toBe(false);
    expect(allReady(markChecking(s))).toBe(false);
    expect(isChecking(markChecking(s))).toBe(true);
    expect(allReady(markError(s, 'rpc_unavailable'))).toBe(false);
  });

  it('marks a card blocked with the server reasons when it is no longer eligible', () => {
    const s = applyAssets(withLots(1), [{ ...core(0), eligible: false, reasons: ['frozen', 'not_owner'] }]);
    expect(s.readiness[mint(0)]).toEqual({ kind: 'blocked', reasons: ['frozen', 'not_owner'] });
    expect(allReady(s)).toBe(false);
  });

  it('treats a card missing from the wallet as not_found', () => {
    const s = applyAssets(withLots(1), []);
    expect(s.readiness[mint(0)]).toEqual({ kind: 'blocked', reasons: ['not_found'] });
  });

  it('needs EVERY lot ready: one blocked lot keeps Publish off', () => {
    let s = withLots(3);
    s = applyAssets(s, [core(0), core(1), { ...core(2), eligible: false, reasons: ['not_owner'] }]);
    expect(allReady(s)).toBe(false);
    expect(canPublish({ ...s, title: 'Good title', start: '2026-10-06T20:00' }, NOW)).toBe(false);
    s = applyAssets(s, [core(0), core(1), core(2)]);
    expect(allReady(s)).toBe(true);
  });

  it('enables Publish exactly when cards, terms, show and readiness are all fine', () => {
    const ok = publishable();
    expect(canPublish(ok, NOW)).toBe(true);
    expect(canPublish({ ...ok, lots: [] }, NOW)).toBe(false);
    expect(canPublish({ ...ok, title: '' }, NOW)).toBe(false);
    expect(canPublish({ ...ok, start: '2026-10-05T12:01' }, NOW)).toBe(false);
    expect(canPublish(setTerm(ok, ok.lots[0].mint, 'opening', '0'), NOW)).toBe(false);
    expect(canPublish({ ...ok, readiness: { [ok.lots[0].mint]: { kind: 'unchecked' } } }, NOW)).toBe(false);
  });

  it('drops the readiness of a card that is taken out again', () => {
    const s = togglePick(publishable(), CORE);
    expect(s.readiness).toEqual({});
    expect(allReady(s)).toBe(false); // no lots is never "ready"
  });
});

describe('buildCreateRequest', () => {
  it('is null while anything blocks Publish', () => {
    expect(buildCreateRequest(withLots(1), NOW)).toBeNull();
  });

  it('produces one POST /api/shows body: base units, UTC start, auto mode, and parses against the contract', () => {
    let s = publishable();
    s = setTerm(s, s.lots[0].mint, 'reserve', '100,5');
    s = setTerm(s, s.lots[0].mint, 'opening', '50');
    s = setTerm(s, s.lots[0].mint, 'increment', '5');
    const body = buildCreateRequest(s, NOW)!;
    expect(body).toEqual({
      title: 'Saturday night slabs',
      format: 'auction',
      mode: 'auto',
      scheduledAt: '2026-10-06T18:00:00.000Z', // 20:00 Berlin, CEST
      lots: [{ mint: CORE.mint, openingPrice: '50000000', increment: '5000000', reserve: '100500000' }],
    });
    expect(CreateShowRequest.safeParse(body).success).toBe(true);
  });

  it('omits the reserve when empty and the start for "start now", and trims the title', () => {
    const s: WizardState = { ...publishable(), title: '  Saturday night slabs  ', when: 'now' };
    const body = buildCreateRequest(s, NOW)!;
    expect(body.title).toBe('Saturday night slabs');
    expect(body).not.toHaveProperty('scheduledAt');
    expect(body.lots[0]).not.toHaveProperty('reserve');
    expect(CreateShowRequest.safeParse(body).success).toBe(true);
  });

  it('accepts 30 lots and every body it builds parses', () => {
    let s = withLots(MAX_LOTS);
    s = { ...s, title: 'Thirty lots', start: '2026-10-06T20:00' };
    s = applyAssets(s, s.lots.map((l) => ({ ...CORE, mint: l.mint, name: l.name })));
    const body = buildCreateRequest(s, NOW)!;
    expect(body.lots).toHaveLength(30);
    expect(CreateShowRequest.safeParse(body).success).toBe(true);
  });
});

describe('optional features in the request (all absent by default)', () => {
  it('a plain show request carries none of the optional fields, so older clients and servers see no change', () => {
    const body = buildCreateRequest(publishable(), NOW)!;
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('videoEnabled');
    expect(body).not.toHaveProperty('rules');
    expect(body.lots[0]).not.toHaveProperty('description');
  });

  it('carries a timed kind with its duration, the video choice and the adopted description of a card, and still parses', () => {
    let s = publishable();
    s = setDescription(s, CORE.mint, { de: 'Text', en: 'Text' }, true, '12');
    s = { ...s, kind: 'timed', durationS: 86_400, videoEnabled: true };
    const body = buildCreateRequest(s, NOW)!;
    expect(body).toMatchObject({ kind: 'timed', videoEnabled: true, rules: { lotDurationS: 86_400 } });
    expect(body.lots[0]).toMatchObject({ description: { de: 'Text', en: 'Text' }, aiAssisted: true, openingPrice: '12000000' });
    expect(CreateShowRequest.safeParse(body).success).toBe(true);
  });

  it('adopting nothing clears the AI mark, and a description is only ever attached to the card it was made for', () => {
    let s = setDescription(publishable(), CORE.mint, { de: 'a', en: 'b' }, true);
    expect(s.lots[0]).toMatchObject({ aiAssisted: true });
    s = setDescription(s, CORE.mint, null, true);
    expect(s.lots[0]).toMatchObject({ description: null, aiAssisted: false });
    expect(setDescription(s, 'some other mint', { de: 'a', en: 'b' }, true).lots[0].description).toBeNull();
  });
});

describe('lot duration of a live show (K14)', () => {
  it('offers 45 s, 90 s, 3 min and 5 min, and 45 s is the default', () => {
    expect([...LOT_DURATION_PRESETS_S]).toEqual([45, 90, 180, 300]);
    expect(DEFAULT_LOT_DURATION_S).toBe(45);
    expect(lotDurationOf(publishable())).toBe(45);
  });

  it('the default request is unchanged: no rules at all, so older servers and a 45 s show behave exactly as before', () => {
    const body = buildCreateRequest(publishable(), NOW)!;
    expect(body).not.toHaveProperty('rules');
    expect(buildCreateRequest(setLotDuration(publishable(), 45), NOW)).not.toHaveProperty('rules');
  });

  it('a chosen length goes out as rules.lotDurationS and the body still parses against the contract', () => {
    for (const s of [90, 180, 300]) {
      const body = buildCreateRequest(setLotDuration(publishable(), s), NOW)!;
      expect(body.rules).toEqual({ lotDurationS: s });
      expect(CreateShowRequest.safeParse(body).success).toBe(true);
    }
  });

  it('ignores anything that is not a preset, and choosing 45 again clears the rule', () => {
    const s = publishable();
    for (const bad of [0, 10, 44, 60, 3600, -45, 45.5, Number.NaN]) expect(setLotDuration(s, bad)).toBe(s);
    expect(buildCreateRequest(setLotDuration(setLotDuration(s, 180), 45), NOW)).not.toHaveProperty('rules');
  });

  it('a timed auction keeps its own duration rule and ignores the live choice', () => {
    const body = buildCreateRequest({ ...setLotDuration(publishable(), 90), kind: 'timed', durationS: 86_400 }, NOW)!;
    expect(body.rules).toEqual({ lotDurationS: 86_400 });
  });
});
