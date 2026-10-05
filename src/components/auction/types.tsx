/**
 * Shared shapes and pure helpers for the auction room.
 *
 * Kept dependency-free (no React) so the money math is easy to trust: everything that isn't
 * plain display formatting reuses the real rules in lib/bidding.ts rather than re-deriving
 * them here, so the room can never show a "next bid" the API would actually reject.
 */

import type { LotDescription, ShowKind } from '@/contracts/common';
import type { ShowOrder } from '@/contracts/vrf';

export type LotState = 'catalogued' | 'open' | 'sold' | 'passed' | 'withdrawn';
export type ShowStatus = 'scheduled' | 'live' | 'ended';

/** One lot as the room draws it: catalogue terms merged with the live state. Money fields are USDC base-unit strings. */
export interface RoomLot {
  id: string;
  lotNumber: number;
  name: string;
  setName?: string | null;
  gradingCompany?: string | null;
  grade?: string | null;
  imageUrl?: string | null;
  insuredValue?: string | null;
  reserve?: string | null;
  increment: string;
  openingPrice: string;
  highBid?: string | null;
  /** The high bidder's public handle, already localized ("Paddle 7"). Never a wallet address. */
  highBidder?: string | null;
  /** True when the high bid is the viewer's own. */
  highBidderIsMe?: boolean;
  /** Sold to a house bot: nothing is paid and the card stays with the house. */
  houseWon?: boolean;
  bidCount?: number;
  closesAt?: string | null;
  state: LotState;
  settlement?: { id: string; status: string; txSignature?: string };
  /** The seller's description per language, and whether it came from a reviewed AI draft (both optional: the practice room has neither). */
  description?: LotDescription | null;
  aiAssisted?: boolean;
}

export interface RoomShow {
  id: string;
  title: string;
  status: ShowStatus;
  cluster: string | null;
  isHouse: boolean;
  settlementMode: 'none' | 'onchain';
  /** From the live snapshot; absent in the practice room. */
  kind?: ShowKind;
  order?: ShowOrder;
  video?: { enabled: boolean };
}

/** The room's beat, derived from the server's lot phase (real rooms) or the practice clock. */
export type RoomPhase = 'open' | 'going-once' | 'going-twice' | 'hammered' | 'gap';

export type VisitorStatus = 'idle' | 'leading' | 'outbid' | 'won' | 'lost';

/** The viewer's standing on the CURRENT lot. */
export interface VisitorInfo {
  status: VisitorStatus;
  lastAmount: bigint | null;
  outbidBy: { paddle: string; amount: bigint } | null;
  hammer: { amount: bigint; toVisitor: boolean } | null;
}
export const IDLE_VISITOR: VisitorInfo = { status: 'idle', lastAmount: null, outbidBy: null, hammer: null };

/** One row in the right-rail feed. Bidders appear as paddle labels only. */
export interface FeedItem {
  key: string;
  /** 'going-once' / 'going-twice' come from the practice room; 'note' is plain narration (time extended, settled). */
  kind: 'bid' | 'opened' | 'sold' | 'passed' | 'withdrawn' | 'chat' | 'going-once' | 'going-twice' | 'note';
  lotNumber?: number;
  amount?: string;
  /** The bidder's paddle label (bids) or the chat author. */
  who?: string;
  text?: string;
  ts: number;
  /** True on a bid row placed by the viewer. */
  mine?: boolean;
}

/**
 * USDC base units (a decimal string, as the API sends it) -> "$1,234.56" (en) or "1.234,56 $" (de).
 * Never via float. Null or unparsable input reads as an en dash (callers print a word such as "No minimum" instead; see limit.ts).
 */
export function formatUsdc(baseUnits: string | null | undefined, locale: string = 'en'): string {
  if (baseUnits == null || baseUnits === '') return '\u2013';
  let n: bigint;
  try {
    n = BigInt(baseUnits);
  } catch {
    return '\u2013';
  }
  const million = BigInt(1_000_000);
  const neg = n < BigInt(0);
  const abs = neg ? -n : n;
  const de = locale.startsWith('de');
  const whole = abs / million;
  const grouped = whole.toLocaleString(de ? 'de-DE' : 'en-US');
  const frac = (abs % million).toString().padStart(6, '0').slice(0, 2);
  return de ? `${neg ? '-' : ''}${grouped},${frac}\u00a0$` : `${neg ? '-$' : '$'}${grouped}.${frac}`;
}

/**
 * The same amount in SOL, for a reader who thinks in SOL: "≈ 0.42 SOL".
 *
 * A DISPLAY CONVENIENCE and nothing else. USDC is what a lot settles in and what every bid,
 * reserve and increment is denominated in; this is computed at the edge, marked approximate, and
 * never fed back into any of them. Returns null when no rate is available, and every caller then
 * shows the USDC price alone rather than a number it cannot stand behind.
 *
 * Float arithmetic is fine HERE and nowhere else in this file: the output is explicitly an
 * approximation to three decimals, so the rounding that makes floats wrong for money is exactly
 * what is wanted.
 */
export function formatSol(baseUnits: string | null | undefined, solUsd: number | null): string | null {
  if (baseUnits == null || baseUnits === '' || !solUsd || solUsd <= 0) return null;
  let n: bigint;
  try {
    n = BigInt(baseUnits);
  } catch {
    return null;
  }
  const usd = Number(n) / 1_000_000;
  const sol = usd / solUsd;
  if (!Number.isFinite(sol)) return null;
  // Below a hundredth of a SOL three decimals would read as 0.00; four keeps a cheap lot honest.
  const decimals = sol < 0.01 ? 4 : 3;
  return `${sol.toFixed(decimals)} SOL`;
}

/** The Solana base transaction fee, in SOL. One signature, 5,000 lamports. Quoted in the
 *  purchase breakdown so a buyer sees the whole cost, not just the hammer price. */
export const SOLANA_BASE_FEE_SOL = 0.000005;

/** A wallet address, shortened for display: "7xKX...gAsU". */
export function shortWallet(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
