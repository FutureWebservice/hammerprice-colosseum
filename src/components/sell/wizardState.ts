/**
 * The new-show wizard as pure functions over one state value (no React, no fetch), so every rule
 * that decides whether "Publish" is enabled has a unit test. The component only wires events to these.
 *
 * Steps: choose the cards, set the price, choose the time (start now or schedule) and publish.
 * Everything else (bid step, per-card prices, show title) has a default and sits behind "Advanced options".
 * Readiness is the server's own ownership read (GET /api/sell/assets, refreshed at the last step): there is
 * no lot id before the show exists, and nothing is signed. After publishing, the manage page can re-run the
 * per-lot check (POST /api/lots/:id/readiness).
 */
import type { CreateShowRequest, SellAsset } from '@/contracts/api';
import type { LotDescription, ShowKind } from '@/contracts/common';
import type { ReadinessReason } from '@/contracts/chain';
import { checkStart, defaultStartLocal, localInputToIso, type StartIssue } from './datetime';
import { parseUsdc, type AmountIssue } from './money';
import { DEFAULT_LOT_DURATION_S, LOT_DURATION_PRESETS_S, isLotDurationPreset } from '@/lib/auction/rules';

export const MAX_LOTS = 30;
/** Used when the seller does not change them. Test currency on devnet; the seller edits them per lot. */
export const DEFAULT_OPENING = '10';
export const DEFAULT_INCREMENT = '1';
/** Same rule as CreateShowRequest.title in contracts/api.ts (the contract test compares the two). */
export const TITLE_RE = /^[\p{L}\p{N} .,:;!?'"&()#+/-]+$/u;

export const STEPS = ['pick', 'price', 'time'] as const;
export type Step = (typeof STEPS)[number];

export interface LotDraft {
  mint: string;
  name: string;
  imageUrl: string | null;
  grade: string | null;
  /** As typed: "12.5" or "12,50". Empty reserve = no reserve. */
  reserve: string;
  opening: string;
  increment: string;
  /** Text the seller adopted (typed or from a reviewed AI draft). Absent = none. */
  description?: LotDescription | null;
  /** The adopted text came from an AI draft the seller reviewed. */
  aiAssisted?: boolean;
}

export type Readiness =
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'blocked'; reasons: ReadinessReason[] }
  | { kind: 'error'; code: string };

/** `now`: the show goes live right after it is published. `schedule`: it starts at `start`. */
export type WhenMode = 'now' | 'schedule';

export interface WizardState {
  step: Step;
  lots: LotDraft[];
  /** Empty = generated from the first card name (see autoTitle). */
  title: string;
  when: WhenMode;
  /** datetime-local value in the viewer's zone. Only used when `when` is `schedule`. */
  start: string;
  readiness: Record<string, Readiness>;
  /** Optional features, all absent by default (a live show, no video): 'timed' needs FEATURE_TIMED, the video checkbox FEATURE_VIDEO. */
  kind?: ShowKind;
  /** Seconds a timed lot runs; absent = the kind's default. */
  durationS?: number | null;
  /** Seconds each lot of a LIVE show runs: one of LOT_DURATION_PRESETS_S. Absent = the default (45 s), which sends no rule at all. */
  lotDurationS?: number;
  videoEnabled?: boolean;
}

export { DEFAULT_LOT_DURATION_S, LOT_DURATION_PRESETS_S };
/** The chosen lot length. Anything that is not a preset is ignored (the server accepts a wider range, the wizard offers these). */
export const setLotDuration = (s: WizardState, seconds: number): WizardState => (isLotDurationPreset(seconds) ? { ...s, lotDurationS: seconds } : s);
export const lotDurationOf = (s: WizardState): number => s.lotDurationS ?? DEFAULT_LOT_DURATION_S;

export const initialState = (now: Date): WizardState => ({ step: 'pick', lots: [], title: '', when: 'now', start: defaultStartLocal(now), readiness: {} });

/** The complement of TITLE_RE: anything in a card name the title contract refuses is dropped. */
const notTitleChar = /[^\p{L}\p{N} .,:;!?'"&()#+/-]/gu;

/** "<card name> auction" (one card) or "<card name> and 2 more" (several), cut to the 80 character limit and cleaned of characters the contract refuses. */
export function autoTitle(lots: LotDraft[], label: (name: string, count: number) => string, fallback: string): string {
  if (lots.length === 0) return fallback;
  const name = lots[0].name.replace(notTitleChar, ' ').replace(/\s+/g, ' ').trim().slice(0, 50).trim();
  const title = (name ? label(name, lots.length) : fallback).slice(0, 80).trim();
  return titleIssue(title) ? fallback : title;
}

/** The state with the generated title filled in when the seller left it empty. The only thing the rules below ever see. */
export const withTitle = (s: WizardState, label: (name: string, count: number) => string, fallback: string): WizardState =>
  s.title.trim() === '' ? { ...s, title: autoTitle(s.lots, label, fallback) } : s;

export const isPicked = (s: WizardState, mint: string) => s.lots.some((l) => l.mint === mint);

/** Add an eligible card (up to 30) or remove a picked one. Anything else is a no-op. */
export function togglePick(s: WizardState, asset: SellAsset): WizardState {
  if (isPicked(s, asset.mint)) {
    const readiness = { ...s.readiness };
    delete readiness[asset.mint];
    return { ...s, lots: s.lots.filter((l) => l.mint !== asset.mint), readiness };
  }
  if (!asset.eligible || asset.listed || s.lots.length >= MAX_LOTS) return s; // a card that is already offered elsewhere is never chosen
  const lot: LotDraft = {
    mint: asset.mint, name: asset.name, imageUrl: asset.imageUrl, grade: asset.grade,
    reserve: '', opening: DEFAULT_OPENING, increment: DEFAULT_INCREMENT,
  };
  return { ...s, lots: [...s.lots, lot], readiness: { ...s.readiness, [asset.mint]: { kind: 'unchecked' } } };
}

export type TermField = 'reserve' | 'opening' | 'increment';
export function setTerm(s: WizardState, mint: string, field: TermField, value: string): WizardState {
  return { ...s, lots: s.lots.map((l) => (l.mint === mint ? { ...l, [field]: value } : l)) };
}
/** One price field for every card (the two visible fields on the price step). */
/** Adopt reviewed text (and optionally a suggested opening price) for one card. Nothing is adopted without the seller's call. */
export const setDescription = (s: WizardState, mint: string, description: LotDescription | null, aiAssisted: boolean, opening?: string): WizardState => ({
  ...s,
  lots: s.lots.map((l) => (l.mint === mint ? { ...l, description, aiAssisted: description ? aiAssisted : false, ...(opening !== undefined ? { opening } : {}) } : l)),
});

export const setAllTerms = (s: WizardState, field: TermField, value: string): WizardState => ({ ...s, lots: s.lots.map((l) => ({ ...l, [field]: value })) });
/** The value every card shares, or null when the cards differ (set per card under "Advanced options"). */
export function sharedTerm(s: WizardState, field: TermField): string | null {
  const first = s.lots[0]?.[field] ?? '';
  return s.lots.every((l) => l[field] === first) ? first : null;
}
/** The first problem any card has with this field, so one input can show it. */
export function firstTermIssue(s: WizardState, field: TermField): TermIssue | null {
  for (const l of s.lots) {
    const i = lotIssues(l)[field];
    if (i) return i;
  }
  return null;
}

export type TermIssue = AmountIssue | 'reserve_below_opening';
export type LotIssues = Partial<Record<TermField, TermIssue>>;

export function lotIssues(l: LotDraft): LotIssues {
  const out: LotIssues = {};
  const opening = parseUsdc(l.opening);
  const increment = parseUsdc(l.increment);
  if (!opening.ok) out.opening = opening.issue;
  if (!increment.ok) out.increment = increment.issue;
  if (l.reserve.trim() !== '') {
    const reserve = parseUsdc(l.reserve);
    if (!reserve.ok) out.reserve = reserve.issue;
    else if (opening.ok && BigInt(reserve.base) < BigInt(opening.base)) out.reserve = 'reserve_below_opening';
  }
  return out;
}

export const termsValid = (s: WizardState) => s.lots.every((l) => Object.keys(lotIssues(l)).length === 0);

export type TitleIssue = 'required' | 'too_short' | 'too_long' | 'characters';
export function titleIssue(title: string): TitleIssue | null {
  const t = title.trim();
  if (t === '') return 'required';
  if (t.length < 3) return 'too_short';
  if (t.length > 80) return 'too_long';
  return TITLE_RE.test(t) ? null : 'characters';
}

export function showIssues(s: WizardState, now: Date): { title?: TitleIssue; start?: StartIssue } {
  const title = titleIssue(s.title);
  const start = s.when === 'schedule' ? checkStart(s.start, now) : null;
  return { ...(title ? { title } : {}), ...(start ? { start } : {}) };
}

/** May the seller leave `step` for the next one? */
export function canLeave(s: WizardState, step: Step): boolean {
  switch (step) {
    case 'pick': return s.lots.length > 0 && s.lots.length <= MAX_LOTS;
    case 'price': return termsValid(s);
    case 'time': return false;
  }
}

// ---- readiness ------------------------------------------------------------------------------

export const markChecking = (s: WizardState): WizardState => ({
  ...s, readiness: Object.fromEntries(s.lots.map((l) => [l.mint, { kind: 'checking' } as Readiness])),
});

export const markError = (s: WizardState, code: string): WizardState => ({
  ...s, readiness: Object.fromEntries(s.lots.map((l) => [l.mint, { kind: 'error', code } as Readiness])),
});

/** Turn a fresh asset list into a readiness verdict per picked lot. A card missing from the list is `not_found`. */
export function applyAssets(s: WizardState, assets: SellAsset[]): WizardState {
  const byMint = new Map(assets.map((a) => [a.mint, a]));
  const readiness: Record<string, Readiness> = {};
  for (const l of s.lots) {
    const a = byMint.get(l.mint);
    if (a?.eligible) readiness[l.mint] = { kind: 'ready' };
    else readiness[l.mint] = { kind: 'blocked', reasons: a && a.reasons.length > 0 ? a.reasons : ['not_found'] };
  }
  return { ...s, readiness };
}

export const allReady = (s: WizardState) => s.lots.length > 0 && s.lots.every((l) => s.readiness[l.mint]?.kind === 'ready');
export const isChecking = (s: WizardState) => s.lots.some((l) => s.readiness[l.mint]?.kind === 'checking');

/** Publish is enabled exactly when every rule holds. */
export const canPublish = (s: WizardState, now: Date) =>
  s.lots.length > 0 && s.lots.length <= MAX_LOTS && termsValid(s) && Object.keys(showIssues(s, now)).length === 0 && allReady(s)
  && !(s.kind === 'timed' && s.lots.length !== 1); // a timed auction is exactly one card

/** The one POST /api/shows body, or null when anything is invalid. Amounts become base-unit strings, the start becomes UTC. */
export function buildCreateRequest(s: WizardState, now: Date): CreateShowRequest | null {
  if (!canPublish(s, now)) return null;
  const scheduledAt = s.when === 'schedule' ? (localInputToIso(s.start) ?? undefined) : undefined;
  const lots = s.lots.map((l) => {
    const opening = parseUsdc(l.opening);
    const increment = parseUsdc(l.increment);
    const reserve = l.reserve.trim() === '' ? null : parseUsdc(l.reserve);
    return {
      mint: l.mint,
      openingPrice: opening.ok ? opening.base : '',
      increment: increment.ok ? increment.base : '',
      ...(reserve?.ok ? { reserve: reserve.base } : {}),
      ...(l.description ? { description: l.description, aiAssisted: l.aiAssisted === true } : {}),
    };
  });
  return {
    title: s.title.trim(), format: 'auction', mode: 'auto', ...(scheduledAt ? { scheduledAt } : {}),
    ...(s.kind === 'timed' ? { kind: 'timed' as const } : {}),
    ...(s.kind === 'timed' && s.durationS ? { rules: { lotDurationS: s.durationS } } : {}),
    // A live show sends a rule only when the seller changed the length: the default request is byte for byte what it was.
    ...(s.kind !== 'timed' && lotDurationOf(s) !== DEFAULT_LOT_DURATION_S ? { rules: { lotDurationS: lotDurationOf(s) } } : {}),
    ...(s.videoEnabled ? { videoEnabled: true } : {}),
    lots,
  };
}
