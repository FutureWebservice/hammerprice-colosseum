/**
 * Auction rules: the timing knobs of a show (`shows.rules` jsonb). `resolveRules` is the only reader of that
 * column: it fills defaults, ignores anything that is not a finite number and clamps every value, so a stale or
 * hand-edited row can never produce a negative timer or a cap below the base duration.
 *
 * Pure. The one environment knob (settlement window) comes in through `envRuleDefaults`.
 */
import type { ShowKind } from '@/contracts/common';
import { resolveCluster } from '@/lib/chain/config';

export interface AuctionRules {
  /** Seconds a lot stays open before any extension. */
  lotDurationS: number;
  /** Phase thresholds: `going_once` inside the last callOnceS seconds, `going_twice` inside the last callTwiceS. */
  callOnceS: number;
  callTwiceS: number;
  /** A bid inside the last snipeWindowS seconds moves the close to at least now + snipeExtendS. */
  snipeWindowS: number;
  snipeExtendS: number;
  /** Cap on the total extension per lot (anti-sniping and seller extends together). */
  maxExtensionS: number;
  /** Result stamp time between a close and the next lot opening. */
  gapS: number;
  /** Seconds after the hammer in which buyer and seller must both sign (config SETTLEMENT_WINDOW_S). */
  settlementWindowS: number;
}

export const SETTLEMENT_WINDOW_DEFAULT_S = 900;

export const RULE_DEFAULTS: AuctionRules = {
  lotDurationS: 45,
  callOnceS: 10,
  callTwiceS: 5,
  snipeWindowS: 15,
  snipeExtendS: 15,
  maxExtensionS: 120,
  gapS: 6,
  settlementWindowS: SETTLEMENT_WINDOW_DEFAULT_S,
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * SETTLEMENT_WINDOW_S: whole seconds between 60 and 7 days. Empty, blank, non-numeric or out of range falls back to
 * 900, never to 0 (an unset variable must not give the parties no time to sign).
 */
export function parseSettlementWindowS(raw: string | undefined): number {
  const s = raw?.trim();
  if (!s || !/^\d{1,7}$/.test(s)) return SETTLEMENT_WINDOW_DEFAULT_S;
  const n = Number(s);
  return n >= 60 && n <= 7 * 86400 ? n : SETTLEMENT_WINDOW_DEFAULT_S;
}

export function envRuleDefaults(env: Record<string, string | undefined> = process.env): AuctionRules {
  return { ...RULE_DEFAULTS, settlementWindowS: parseSettlementWindowS(env.SETTLEMENT_WINDOW_S) };
}

// ---------------------------------------------------------------------------------------------
// Timed shows: one lot that runs for hours or days (FEATURE_TIMED)
// ---------------------------------------------------------------------------------------------

/** The shortest timed lot (10 minutes) and the longest (14 days). */
export const TIMED_MIN_DURATION_S = 600;
export const TIMED_MAX_DURATION_S = 1_209_600;

/** Defaults of a timed show: one day, a call only in the last 5 minutes, a 5 minute soft close, no gap, 3 days to sign. */
export const TIMED_RULE_DEFAULTS: AuctionRules = {
  lotDurationS: 86_400,
  callOnceS: 300,
  callTwiceS: 60,
  snipeWindowS: 300,
  snipeExtendS: 300,
  maxExtensionS: 86_400,
  gapS: 0,
  settlementWindowS: 259_200,
};

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------
// The seller's pause. Fixed limits that protect bidders; not per-show rules, so a show cannot loosen them.
// ---------------------------------------------------------------------------------------------

/** At most this many pauses per show. */
export const PAUSE_MAX_COUNT = 2;
/** A pause ends by itself after this long (the seller may resume sooner). */
export const PAUSE_MAX_MS = 5 * 60_000;
/** A pause is refused when the open lot has less than this left: no pausing in the last seconds of a lot. */
export const PAUSE_MIN_LEFT_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// The seller's choice of lot duration on a third-party live show (K14): presets inside the bounds of resolveRules (10 s to 1 h)
// ---------------------------------------------------------------------------------------------

/** Lot durations the sell wizard offers, in seconds. 45 is the default and what every show created before this option has. */
export const LOT_DURATION_PRESETS_S = [45, 90, 180, 300] as const;
/** The bounds resolveRules clamps a live lot's duration to (the contract already refuses fewer than 10 s and a non-integer). */
export const LIVE_LOT_MIN_S = 10;
export const LIVE_LOT_MAX_S = 3600;
export const DEFAULT_LOT_DURATION_S = RULE_DEFAULTS.lotDurationS;
export const isLotDurationPreset = (n: unknown): n is (typeof LOT_DURATION_PRESETS_S)[number] => typeof n === 'number' && (LOT_DURATION_PRESETS_S as readonly number[]).includes(n);

/**
 * The shortest timed lot in this environment. 600 s, except that a TEST environment may lower it with TIMED_MIN_DURATION_S (10 to 599).
 * The variable never has an effect on mainnet, and a cluster setting that cannot be resolved counts as mainnet (fail safe).
 */
export function timedMinDurationS(env: Env = process.env): number {
  const raw = env.TIMED_MIN_DURATION_S?.trim();
  if (!raw || !/^\d{1,3}$/.test(raw)) return TIMED_MIN_DURATION_S;
  const n = Number(raw);
  if (n < 10 || n >= TIMED_MIN_DURATION_S) return TIMED_MIN_DURATION_S;
  try {
    return resolveCluster(env) === 'mainnet-beta' ? TIMED_MIN_DURATION_S : n;
  } catch {
    return TIMED_MIN_DURATION_S;
  }
}

/** The largest `seconds` a seller's extend may ask for: 10 minutes on a live show, 1 hour on a timed one. */
export const maxSellerExtendS = (kind: ShowKind): number => (kind === 'timed' ? 3600 : 600);

/**
 * Fills defaults and clamps. Unknown keys and non-finite numbers are ignored. Idempotent.
 *
 * `kind` is the show's kind ('live' or 'timed'). A LIVE show uses the first table (unchanged: a golden test compares every value against the previous
 * implementation). A TIMED show uses its own table and its own defaults (`defaults` is the live default set and is not used for it):
 *
 *   key               live (default)         timed (default)
 *   lotDurationS      10..3600 (45)          min..1_209_600 (86_400), min = 600 (timedMinDurationS)
 *   callOnceS         1..lotDurationS (10)   1..lotDurationS (300)
 *   callTwiceS        1..callOnceS (5)       1..callOnceS (60)
 *   snipeWindowS      0..lotDurationS (15)   0..min(3600, lotDurationS) (300)
 *   snipeExtendS      0..600 (15)            0..3600 (300)
 *   maxExtensionS     0..600 (120)           0..604_800 (86_400)
 *   gapS              0..600 (6)             0..600 (0)
 *   settlementWindowS 60..604_800 (900)      60..604_800 (259_200)
 */
export function resolveRules(raw: unknown, defaults: AuctionRules = RULE_DEFAULTS, kind: ShowKind = 'live', env: Env = process.env): AuctionRules {
  const timed = kind === 'timed';
  const base = timed ? TIMED_RULE_DEFAULTS : defaults;
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (k: keyof AuctionRules): number => {
    const v = src[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : base[k];
  };
  const lotDurationS = timed ? clamp(pick('lotDurationS'), timedMinDurationS(env), TIMED_MAX_DURATION_S) : clamp(pick('lotDurationS'), LIVE_LOT_MIN_S, LIVE_LOT_MAX_S);
  const callOnceS = clamp(pick('callOnceS'), 1, lotDurationS);
  return {
    lotDurationS,
    callOnceS,
    callTwiceS: clamp(pick('callTwiceS'), 1, callOnceS),
    snipeWindowS: clamp(pick('snipeWindowS'), 0, timed ? Math.min(3600, lotDurationS) : lotDurationS),
    snipeExtendS: clamp(pick('snipeExtendS'), 0, timed ? 3600 : 600),
    maxExtensionS: clamp(pick('maxExtensionS'), 0, timed ? 604_800 : 600),
    gapS: clamp(pick('gapS'), 0, 600),
    settlementWindowS: clamp(pick('settlementWindowS'), 60, 7 * 86400),
  };
}
