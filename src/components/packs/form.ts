/**
 * The operator's "new pack" form as text: odds and cards are typed one per line, separated by semicolons, and turned into the strict
 * PackCreateRequest of the contract. Pure and testable; the server checks everything again (ownership, readiness, odds, duplicates).
 *
 *   odds line:  <tier id>; <German name>; <English name>; <chance in percent>
 *               (shorter is fine: "<tier id>; <name>; <chance>" uses one name for both languages, "<tier id>; <chance>" uses the id as the name)
 *   card line:  <Core asset address>; [<tier id>]; <name>; [<image https URL>]; [<listed value in USDC>]
 *               (an empty tier id means the first tier of the odds, which is what the wallet picker writes)
 */
import { PackCreateRequest } from '@/contracts';
import { parseUsdc } from '@/lib/client/bidder';

export interface FormInput {
  nameDe: string;
  nameEn: string;
  price: string;
  cap: string;
  mode: 'chance' | 'equal_value';
  odds: string;
  cards: string;
}
export interface FormIssue { line: number; why: string }
export type FormResult = { ok: true; request: PackCreateRequest } | { ok: false; issues: FormIssue[]; oddsSum?: number };

const lines = (s: string) => s.split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => x.l !== '');
const cells = (l: string) => l.split(';').map((c) => c.trim());
const TIER = /^[a-z0-9_-]{1,24}$/;
/** A rarity id as people write it ("Rare", "Ultra Rare", "Selten") becomes a valid one ("rare", "ultra-rare", "selten"); the same on the odds line and on a card line, so they still match. */
const tierId = (raw: string): string => raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

/** What the form starts with, so it saves as it is: one rarity for an equal-value pack, two for a chance pack. */
export const DEFAULT_ODDS: Record<FormInput['mode'], string> = {
  equal_value: 'all; Alle Karten; All cards; 100',
  chance: 'common; Häufig; Common; 80\nrare; Selten; Rare; 20',
};
export const START: FormInput = { nameDe: 'Mein Pack', nameEn: 'My pack', price: '5', cap: '5', mode: 'equal_value', odds: DEFAULT_ODDS.equal_value, cards: '' };

/** Switching the pack type swaps the odds for the other default (only while they are still the untouched default) and moves the cards along to its first rarity. */
export function switchMode(f: FormInput, mode: FormInput['mode']): FormInput {
  if (mode === f.mode) return f;
  if (f.odds.trim() !== DEFAULT_ODDS[f.mode]) return { ...f, mode };
  const from = lines(DEFAULT_ODDS[f.mode]).map(({ l }) => tierId(cells(l)[0] ?? ''));
  const to = tierId(cells(DEFAULT_ODDS[mode])[0] ?? '');
  const cardRows = f.cards.split('\n').map((l) => { const c = cells(l); return c.length > 1 && from.includes(tierId(c[1]!)) ? [c[0], to, ...c.slice(2)].join('; ') : l; });
  return { ...f, mode, odds: DEFAULT_ODDS[mode], cards: cardRows.join('\n') };
}

/** "70", "33,33" or "70 %" to basis points; null unless it is above 0, at most 100 and has at most 2 decimals (cents are checked with a tolerance: 0.07 * 100 is 7.000000000000001). */
const bpsOf = (pct: string): number | null => {
  const bps = Number(pct.replace(/%$/, '').replace(',', '.')) * 100;
  return Number.isFinite(bps) && bps >= 1 && bps <= 10_000 && Math.abs(bps - Math.round(bps)) < 1e-6 ? Math.round(bps) : null;
};

/** One odds line, read the same way by the live preview and by the check at submit. The chance is the last cell of a short line; a missing name is the other language's name, then the id. */
function oddsLine(l: string) {
  const c = cells(l);
  const raw = c[0] ?? '';
  const tier = tierId(raw);
  const [a = '', b = ''] = c.length > 3 ? [c[1], c[2]] : c.slice(1, -1);
  const pct = (c.length > 3 ? c[3] : c.length > 1 ? c[c.length - 1] : '') ?? '';
  return { tier, label: { de: a || b || raw, en: b || a || raw }, bps: bpsOf(pct) };
}

export function parsePackForm(i: FormInput): FormResult {
  const issues: FormIssue[] = [];
  const odds: { tier: string; label: { de: string; en: string }; bps: number }[] = [];
  for (const { l, n } of lines(i.odds)) {
    const o = oddsLine(l);
    if (!TIER.test(o.tier)) issues.push({ line: n, why: 'the first entry is the rarity id, for example: common' });
    else if (o.bps === null) issues.push({ line: n, why: 'chance: percent above 0, at most 2 decimals' });
    else odds.push({ tier: o.tier, label: o.label, bps: o.bps });
  }
  const oddsSum = odds.reduce((a, o) => a + o.bps, 0);
  const price = parseUsdc(i.price);
  const cards: { asset: string; tier: string; name: string; imageUrl?: string; listedValue?: string }[] = [];
  for (const { l, n } of lines(i.cards)) {
    const [asset = '', tier0 = '', name = '', image = '', value = ''] = cells(l);
    const tier = tierId(tier0) || odds[0]?.tier || '';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset)) { issues.push({ line: n, why: 'asset address' }); continue; }
    if (!tier || !name) { issues.push({ line: n, why: 'tier id and name needed' }); continue; }
    if (image && !/^https:\/\//.test(image)) { issues.push({ line: n, why: 'image must be an https URL' }); continue; }
    const v = value ? parseUsdc(value) : i.mode === 'equal_value' ? price : null; // an equal-value card without a value is listed at the pack price
    if (value && v === null) { issues.push({ line: n, why: 'listed value in USDC' }); continue; }
    cards.push({ asset, tier, name, ...(image ? { imageUrl: image } : {}), ...(v !== null ? { listedValue: v.toString() } : {}) });
  }
  if (price === null || price === 0n) issues.push({ line: 0, why: 'price in USDC, above 0' });
  const cap = Number(i.cap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 50) issues.push({ line: 0, why: 'daily limit: 1 to 50' });
  if (odds.length > 0 && oddsSum !== 10_000) return { ok: false, issues, oddsSum: oddsSum / 100 };
  if (issues.length > 0) return { ok: false, issues };
  // A rarity without a card can never be drawn (the server refuses it): it is left out and the other rarities share its chance, in proportion.
  const used = odds.filter((o) => cards.some((c) => c.tier === o.tier));
  if (used.length > 0 && used.length < odds.length) {
    const kept = used.reduce((a, o) => a + o.bps, 0);
    const shares = used.map((o) => Math.floor((o.bps * 10_000) / kept));
    shares[shares.indexOf(Math.max(...shares))]! += 10_000 - shares.reduce((a, b) => a + b, 0);
    odds.splice(0, odds.length, ...used.map((o, k) => ({ ...o, bps: shares[k]! })));
  }
  const parsed = PackCreateRequest.safeParse({
    name: { de: i.nameDe.trim() || i.nameEn.trim(), en: i.nameEn.trim() || i.nameDe.trim() }, mode: i.mode, price: price!.toString(), odds, cards, perWalletDailyCap: cap,
  });
  if (!parsed.success) return { ok: false, issues: [{ line: 0, why: parsed.error.issues[0]?.message ?? 'invalid' }] };
  return { ok: true, request: parsed.data };
}

/** The odds lines typed so far, for the live preview: the valid rows and their sum in basis points (invalid lines are skipped here; parsePackForm reports them). */
export function previewOdds(odds: string): { rows: { tier: string; label: { de: string; en: string }; bps: number }[]; sumBps: number } {
  const rows: { tier: string; label: { de: string; en: string }; bps: number }[] = [];
  for (const { l } of lines(odds)) {
    const o = oddsLine(l);
    if (TIER.test(o.tier) && o.bps !== null) rows.push({ tier: o.tier, label: o.label, bps: o.bps });
  }
  return { rows, sumBps: rows.reduce((a, o) => a + o.bps, 0) };
}

/** One pool line for a card the operator picked from the wallet (the tier is the first tier of the odds, the operator can change it). */
export const cardLine = (c: { mint: string; name: string; imageUrl: string | null }, tier: string): string =>
  [c.mint, tier, c.name.replace(/;/g, ','), c.imageUrl && c.imageUrl.startsWith('https://') ? c.imageUrl : '', ''].join('; ');
