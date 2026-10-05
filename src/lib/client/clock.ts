/**
 * Server-clock offset. The server decides every deadline; the browser only
 * draws it. `offset = serverNow - (clientNow at receipt - rtt / 2)`, median of the last five samples so one
 * slow or CDN-cached response cannot drag the countdown. Pure: callers pass the times in.
 */
const KEEP = 5;

export function addOffsetSample(samples: readonly number[], serverNow: number, sentAt: number, receivedAt: number): number[] {
  const rtt = Math.max(0, receivedAt - sentAt);
  return [...samples, serverNow - (receivedAt - rtt / 2)].slice(-KEEP);
}

export function medianOffset(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Best estimate of the server's clock right now, in WHOLE milliseconds: the offset is a median of half-rtt samples and can be
 * fractional, and this value goes into signed texts (paddle `valid`, bid `issued`) whose strict parsers accept integers only.
 */
export const serverTime = (offset: number, clientNow: number): number => Math.round(clientNow + offset);

/** Milliseconds until an ISO deadline on the server clock (negative once it has passed); null without a deadline. */
export function msUntil(iso: string | null | undefined, offset: number, clientNow: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t - serverTime(offset, clientNow) : null;
}

/** "0:07" style countdown. Never negative; rounds up so 0.4 s left still reads 0:01. */
export function formatCountdown(ms: number | null): string {
  if (ms == null) return '--:--';
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
