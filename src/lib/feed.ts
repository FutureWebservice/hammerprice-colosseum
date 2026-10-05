/**
 * Which lot a live event belongs to.
 *
 * The event payload is the source of truth: both `POST /api/bids` and `openLot()` write
 * lotNumber into the show_events payload at the moment they already hold the lot row, so no
 * client-side lookup is needed for anything written from here on.
 *
 * The catalogue lookup stays as a fallback for rows written before that was true. It matters
 * because of ordering: EventSource replays buffered events from Last-Event-ID on reconnect,
 * and those can arrive before the room's initial GET /api/shows/[id] has resolved. A lookup
 * against a catalogue that is still empty returns undefined, and the feed then renders a lot
 * reference with nothing in it ("3Tuv…roeA · lot"). Callers must treat undefined as "omit the
 * reference", never as "render an empty one".
 */
export function resolveLotNumber(
  payload: { lotNumber?: unknown; lotId?: unknown },
  lots: ReadonlyArray<{ id: string; lotNumber: number }> | undefined,
): number | undefined {
  // Number.isInteger, not a truthiness check: lot 0 is a number like any other.
  if (Number.isInteger(payload.lotNumber)) return payload.lotNumber as number;
  if (typeof payload.lotId !== 'string' || !lots) return undefined;
  return lots.find((l) => l.id === payload.lotId)?.lotNumber;
}
