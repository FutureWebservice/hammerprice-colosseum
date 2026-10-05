'use client';

/**
 * What the assistant drawer in a room knows about the room, beyond the lot it passes to the agent:
 *  - `facts`: the "right now in this room" line (lot number, highest bid, time left), composed in the browser from the PUBLIC live snapshot
 *    (GET /api/auctions/:id/live) on the server's clock. Nothing the user typed goes into it. It refreshes while the drawer is open.
 *  - `operator`: whether this visitor is the room's operator (the chat's `mine` route says; 404 while the chat is off), for the
 *    "Publish in the room chat" action under an answer.
 * Both are only asked while the drawer is open, and only in a room (a showId).
 */
import { useEffect, useState } from 'react';
import { ChatMineResponse, LiveSnapshot } from '@/contracts';
import { liveFacts, type LiveFacts } from './live';

const EVERY_MS = 5_000;

export function useRoomContext(showId: string | undefined, active: boolean, signedIn: boolean): { facts: LiveFacts | null; msLeft: number | null; operator: boolean } {
  const [snap, setSnap] = useState<{ facts: LiveFacts; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [operator, setOperator] = useState(false);

  useEffect(() => {
    if (!showId || !active) return;
    let live = true;
    const load = async () => {
      const r = await fetch(`/api/auctions/${encodeURIComponent(showId)}/live`, { cache: 'no-store' }).catch(() => null);
      const p = r?.ok ? LiveSnapshot.safeParse(await r.json().catch(() => null)) : null;
      if (live) setSnap(p?.success ? { facts: liveFacts(p.data), at: Date.now() } : { facts: { lotNumber: null, highBidUsdc: null, msLeft: null }, at: Date.now() });
    };
    void load();
    const poll = setInterval(() => void load(), EVERY_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => { live = false; clearInterval(poll); clearInterval(tick); };
  }, [showId, active]);

  useEffect(() => {
    if (!showId || !active || !signedIn) { setOperator(false); return; }
    let live = true;
    fetch(`/api/shows/${encodeURIComponent(showId)}/chat/mine`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { const p = ChatMineResponse.safeParse(j); if (live) setOperator(p.success && p.data.operator); }).catch(() => {});
    return () => { live = false; };
  }, [showId, active, signedIn]);

  const msLeft = snap && snap.facts.msLeft !== null ? Math.max(0, snap.facts.msLeft - (now - snap.at)) : null;
  return { facts: snap?.facts ?? null, msLeft, operator };
}
