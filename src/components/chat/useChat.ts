'use client';

/**
 * The room chat's data: the public list (polled; the same answer for everybody, so the CDN absorbs it), the viewer's own waiting and rejected
 * messages, and, for the room operator only, the moderation queue. Polling is slow while the panel is closed, fast while it is open, paused in a
 * hidden tab, and backs off after errors. Nothing here writes except `send`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatOwnMessage } from '@/contracts';
import { ChatError, fetchMine, fetchPublic, fetchQueue, hasSession, newNonce, pollDelayMs, sendMessage, type Queue, type QueueFilter } from './chatClient';

export interface UseChatOptions {
  showId: string;
  /** The panel is open: poll faster. */
  open: boolean;
  /** The viewer holds a paddle in this show (so they are signed in). */
  hasPaddle: boolean;
  /** The operator's moderation view is on screen: poll the queue faster. */
  moderating: boolean;
  filter: QueueFilter;
}

export interface UseChat {
  /** null until the first answer; false = the feature is off here, the room shows nothing. */
  enabled: boolean | null;
  messages: ChatMessage[];
  signedIn: boolean;
  mine: ChatOwnMessage[];
  operator: boolean;
  queue: Queue | null;
  /** Public messages that arrived since the panel was last open. */
  unread: number;
  /** New public messages to announce to screen readers: set at most every 8 s while the panel is open; `id` changes on every announcement. */
  announce: { count: number; id: number } | null;
  send: (body: string, lotNumber: number | null) => Promise<void>;
  refresh: () => void;
  refreshQueue: () => void;
  markRead: () => void;
}

const ANNOUNCE_EVERY_MS = 8_000;

/** A timer loop that can be woken early. `step` returns the delay until the next run. */
export function useLoop(step: () => Promise<number>, active: boolean, deps: unknown[]): () => void {
  const wake = useRef<() => void>(() => {});
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      if (typeof document !== 'undefined' && document.hidden) { timer = setTimeout(() => void run(), 2_000); return; }
      running = true;
      let delay = 10_000;
      try { delay = await stepRef.current(); } finally { running = false; }
      if (!stopped) timer = setTimeout(() => void run(), delay);
    };
    wake.current = () => { if (timer) clearTimeout(timer); void run(); };
    void run();
    const onVisible = () => { if (!document.hidden) wake.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
  return useCallback(() => wake.current(), []);
}

export function useChat({ showId, open, hasPaddle, moderating, filter }: UseChatOptions): UseChat {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [mine, setMine] = useState<ChatOwnMessage[]>([]);
  const [operator, setOperator] = useState(false);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [unread, setUnread] = useState(0);
  const [announce, setAnnounce] = useState<{ count: number; id: number } | null>(null);

  const openRef = useRef(open);
  openRef.current = open;
  const seen = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);
  const lastAnnounce = useRef(0);
  const errors = useRef({ pub: 0, mine: 0, queue: 0 });

  // --- public list ---------------------------------------------------------------------------
  const refresh = useLoop(async () => {
    try {
      const r = await fetchPublic(showId);
      errors.current.pub = 0;
      setEnabled(r.enabled);
      if (r.enabled) {
        setMessages(r.messages);
        const fresh = r.messages.filter((m) => !seen.current.has(m.id));
        for (const m of fresh) seen.current.add(m.id);
        if (firstLoad.current) firstLoad.current = false;
        else if (fresh.length > 0) {
          if (!openRef.current) setUnread((n) => n + fresh.length);
          else if (Date.now() - lastAnnounce.current > ANNOUNCE_EVERY_MS) { lastAnnounce.current = Date.now(); setAnnounce({ count: fresh.length, id: lastAnnounce.current }); }
        }
      }
      return pollDelayMs({ open: openRef.current, enabled: r.enabled, errorStreak: 0, random: Math.random() });
    } catch {
      errors.current.pub++;
      return pollDelayMs({ open: openRef.current, enabled: true, errorStreak: errors.current.pub, random: Math.random() });
    }
  }, true, [showId]);

  // --- is there a session --------------------------------------------------------------------
  useEffect(() => {
    let live = true;
    if (hasPaddle) { setSignedIn(true); return undefined; }
    void hasSession(showId).then((ok) => { if (live) setSignedIn(ok); });
    return () => { live = false; };
  }, [showId, hasPaddle]);

  // --- the viewer's own messages (and whether they are the operator) ---------------------------
  const refreshMine = useLoop(async () => {
    try {
      const r = await fetchMine(showId);
      errors.current.mine = 0;
      setMine(r.messages);
      setOperator(r.operator);
      const waiting = r.messages.some((m) => m.status === 'pending');
      // Open: every 5 s. Closed: only while something is waiting or for the operator (the badge), every 15 s.
      return openRef.current ? Math.round(5_000 * (0.9 + Math.random() * 0.2)) : waiting || r.operator ? 15_000 : 60_000;
    } catch (e) {
      if (e instanceof ChatError && (e.code === 'unauthenticated' || e.code === 'feature_off')) { setSignedIn(false); return 60_000; }
      errors.current.mine++;
      return pollDelayMs({ open: openRef.current, enabled: true, errorStreak: errors.current.mine, random: Math.random() });
    }
  }, signedIn && enabled === true, [showId, signedIn, enabled, hasPaddle]);

  // --- the operator's queue ---------------------------------------------------------------------
  const moderatingRef = useRef(moderating);
  moderatingRef.current = moderating;
  const refreshQueue = useLoop(async () => {
    try {
      const r = await fetchQueue(showId, filter);
      errors.current.queue = 0;
      setQueue(r);
      return openRef.current && moderatingRef.current ? 4_000 : 15_000;
    } catch (e) {
      if (e instanceof ChatError && e.code === 'not_seller') { setOperator(false); return 60_000; }
      errors.current.queue++;
      return pollDelayMs({ open: true, enabled: true, errorStreak: errors.current.queue, random: Math.random() });
    }
  }, operator && enabled === true, [showId, operator, enabled, filter]);

  // Opening the panel brings fresh data at once.
  useEffect(() => {
    if (!open) return;
    refresh();
    refreshMine();
    if (operator) refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const nonce = useRef<{ body: string; id: string } | null>(null);
  const send = useCallback(async (body: string, lotNumber: number | null) => {
    // The same text after a network failure keeps its key, so a retry of a message that did arrive is not stored twice.
    const clientNonce = nonce.current && nonce.current.body === body ? nonce.current.id : newNonce();
    nonce.current = { body, id: clientNonce };
    try {
      const m = await sendMessage(showId, { body, clientNonce, ...(lotNumber != null ? { lotNumber } : {}) });
      nonce.current = null;
      setMine((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      refresh();
      refreshMine();
      if (operator) refreshQueue();
    } catch (e) {
      if (!(e instanceof ChatError && e.code === 'network')) nonce.current = null;
      throw e;
    }
  }, [showId, operator, refresh, refreshMine, refreshQueue]);

  const markRead = useCallback(() => setUnread(0), []);

  // Messages the operator approved leave "mine" (they are public now): the public list is their only home.
  const publicIds = new Set(messages.map((m) => m.id));
  const visibleMine = mine.filter((m) => m.status !== 'approved' && !publicIds.has(m.id));

  return { enabled, messages, signedIn, mine: visibleMine, operator, queue, unread, announce, send, refresh, refreshQueue, markRead };
}
