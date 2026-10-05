/** The "right now in this room" line of the assistant, composed from the PUBLIC live snapshot (no server round trip, nothing the asker typed). Pure. */
import type { z } from 'zod';
import type { LiveSnapshot } from '@/contracts';

type Snapshot = z.infer<typeof LiveSnapshot>;
export interface LiveFacts { lotNumber: number | null; highBidUsdc: string | null; msLeft: number | null }

/** USDC base units to "12.50" (cents only, as the room shows it). */
export const usdc = (base: string): string => { const c = BigInt(base) / 10_000n; return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`; };
export const clock = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };

export function liveFacts(s: Snapshot, nowMs: number = Date.now()): LiveFacts {
  const cur = s.current;
  if (!cur) return { lotNumber: null, highBidUsdc: null, msLeft: null };
  const lot = s.lots.find((l) => l.id === cur.lotId);
  const offset = s.serverNow - nowMs; // the clock of the server, not of this device
  return { lotNumber: cur.lotNumber, highBidUsdc: lot?.highBid ?? null, msLeft: cur.closesAt ? Math.max(0, new Date(cur.closesAt).getTime() - (nowMs + offset)) : null };
}
