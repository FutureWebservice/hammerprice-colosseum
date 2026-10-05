'use client';

/**
 * The real auction room, built on the public LiveSnapshot (polled by useLiveRoom), the viewer's /api/me, and the
 * co-signed settlement. It never imports a demo-* module: the simulated room is PracticeRoom, used only for the
 * legacy demo show id.
 *
 * Data: catalogue once, snapshot by polling, server clock offset for the countdown. The browser draws deadlines
 * and never decides one. Bidding: one Get ready sheet (connect, verify, test funds, bidding number = paddle with a temporary
 * key in sessionStorage), then a binding bid behind a confirmation step, shown optimistically and reconciled against the next snapshot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSession } from '@/components/auth/SessionProvider';
import { useLiveRoom } from '@/hooks/useLiveRoom';
import { useBid, type BidError } from '@/hooks/useBid';
import { useMe } from '@/hooks/room/useMe';
import { useNow } from '@/hooks/room/useNow';
import { usePaddle } from '@/hooks/room/usePaddle';
import { useRoomSignIn } from '@/hooks/room/useRoomSignIn';
import { useUsd } from '@/hooks/room/useUsd';
import { isHousePaddle } from '@/server/house/bots';
import { extensionSeconds, isPaused, lotMsLeft } from '@/lib/client/live';
import { msUntil, serverTime } from '@/lib/client/clock';
import { parseBidPrefill, withoutPrefill, type BidPrefill } from './prefill';
import { Assistant, GetReadySheet, PayModal, SideChat } from '@/components/room/lazy';
import RoomShell from '@/components/room/RoomShell';
import PauseBanner from '@/components/room/PauseBanner';
import { DemoNote } from '@/components/room/DemoBadge';
import SettlementDesk from '@/components/room/SettlementDesk';
import WalletSheet from '@/components/room/WalletSheet';
import BidControl from './BidControl';
import CatalogueRail from './CatalogueRail';
import EventRail from './EventRail';
import Stage from './Stage';
import WinModal, { useWonLot } from './WinModal';
import { DemoOutbidModal, useLostLot } from '@/components/room/DemoOutcome';
import NextStepLine from '@/components/explain/NextStepLine';
import { markHintConfirmed } from '@/components/explain/WalletPromptHint';
import Tour from '@/components/tour/Tour';
import { settlementFromPending } from '@/lib/client/next-step';
import { normalizeCluster } from '@/lib/auth/config';
import { errorText } from './errors';
import {
  applyOptimistic, bidGate, buildRoomLots, currentLotOf, feedFromEvents, nextBidOf, optimisticResolved, roomPhaseOf, roomShowOf, visitorOf,
  type Optimistic, type Tr,
} from './model';
import type { FeedItem } from './types';

interface PayTarget { id: string; agreedGross: string | null }

function Frame({ locale, title, children }: { locale: string; title: string; children: React.ReactNode }) {
  return (
    <RoomShell locale={locale} title={title} status={null}>
      <div className="ar-notice">{children}</div>
    </RoomShell>
  );
}

export default function AuctionRoom({ showId, solUsd = null }: { showId: string; solUsd?: number | null }) {
  const locale = useLocale();
  const t = useTranslations('room');
  const usd = useUsd();
  const tr = t as unknown as Tr;

  const live = useLiveRoom(showId);
  const { snapshot, catalogue, offset } = live;
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const me = useMe(showId, wallet);
  const now = useNow(250);

  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const serverNow = useCallback(() => serverTime(offsetRef.current, Date.now()), []);

  const cluster = snapshot?.show.cluster ?? null;
  const myPaddle = me.me?.paddle?.number ?? null;
  // Paddles 1..HOUSE_BOT_COUNT of a house show are the house's automated bidders: the room says so wherever it names a paddle.
  const isHouse = snapshot?.show.isHouse ?? false;
  const isHouseBidder = useCallback((n: number) => isHouse && isHousePaddle(n), [isHouse]);
  const label = useCallback((n: number) => t(isHouseBidder(n) ? 'paddle.house' : 'paddle.label', { number: n }), [t, isHouseBidder]);

  // --- sign in and paddle ---------------------------------------------------------------------
  // The header's session control follows the room's sign-in: it must not keep asking for a second one.
  const session = useSession();
  const signIn = useRoomSignIn(async () => { await me.refresh(); await session.refresh(); });
  const paddle = usePaddle({ showId, cluster, wallet, me: me.me, nowMs: serverNow, refreshMe: me.refresh });
  const [walletSheet, setWalletSheet] = useState(false);
  const [chatOn, setChatOn] = useState(false); // the real room chat is running: hide the local-only message box
  const [readySheet, setReadySheet] = useState(false);

  // --- lots, phase and countdown ----------------------------------------------------------------
  const baseLots = useMemo(() => (catalogue ? buildRoomLots(catalogue, snapshot, label, myPaddle, isHouseBidder) : []), [catalogue, snapshot, label, myPaddle, isHouseBidder]);
  const [optimistic, setOptimistic] = useState<Optimistic | null>(null);
  const lots = useMemo(() => applyOptimistic(baseLots, optimistic, myPaddle != null ? label(myPaddle) : t('feed.youFallback')), [baseLots, optimistic, myPaddle, label, t]);
  useEffect(() => { if (optimistic && optimisticResolved(baseLots, optimistic)) setOptimistic(null); }, [baseLots, optimistic]);
  useEffect(() => {
    if (!optimistic) return undefined;
    const id = setTimeout(() => setOptimistic(null), 8_000);
    return () => clearTimeout(id);
  }, [optimistic]);

  const show = snapshot ? roomShowOf(snapshot.show) : null;
  const current = show ? currentLotOf(lots, snapshot, show.status) : null;
  const phase = roomPhaseOf(snapshot?.current?.phase);
  const nowMs = now ?? 0;
  // Payment deadlines seen so far (/api/me stops listing a settlement once it is overdue), so the win dialog can say "payment window ended" by itself.
  const dueAts = useRef(new Map<string, string>());
  for (const p of me.me?.pending ?? []) dueAts.current.set(p.settlementId, p.dueAt);
  const paused = isPaused(snapshot);
  // While the seller's pause holds the room the countdown stands still at the time the lot gets back on resume.
  const msLeft = now != null && snapshot?.current ? lotMsLeft(snapshot, serverTime(offset, nowMs)) : null;
  const msToResume = paused && now != null ? msUntil(snapshot?.show.pause.resumesBy, offset, nowMs) : null;
  const msToNext = now != null && snapshot?.current ? msUntil(snapshot.current.nextOpensAt, offset, nowMs) : null;

  const peak = useRef({ id: '', ms: 0 });
  const lotKey = snapshot?.current?.lotId ?? '';
  if (peak.current.id !== lotKey) peak.current = { id: lotKey, ms: 0 };
  if (msLeft != null && msLeft > peak.current.ms) peak.current.ms = msLeft;

  // Anti-snipe: show the extension when the server moved this lot's deadline forward.
  const prevSnapshot = useRef(snapshot);
  const [extendedBy, setExtendedBy] = useState(0);
  useEffect(() => {
    const added = extensionSeconds(prevSnapshot.current, snapshot);
    prevSnapshot.current = snapshot;
    if (added <= 0) return undefined;
    setExtendedBy(added);
    const id = setTimeout(() => setExtendedBy(0), 6_000);
    return () => clearTimeout(id);
  }, [snapshot]);

  const [jitter, setJitter] = useState(0);
  useEffect(() => { setJitter((j) => j + 1); }, [current?.id, current?.highBid]);

  // --- standing, gate and bidding --------------------------------------------------------------
  const [bidOn, setBidOn] = useState<ReadonlySet<string>>(new Set());
  const standingLot = me.me?.standing?.lotId;
  useEffect(() => { if (standingLot) setBidOn((s) => (s.has(standingLot) ? s : new Set(s).add(standingLot))); }, [standingLot]);
  const visitor = useMemo(() => visitorOf(current, bidOn), [current, bidOn]);
  const nextAmount = nextBidOf(current);

  const bid = useBid({ showId, cluster, wallet, paddle: paddle.key, serverNow, onSnapshot: live.applySnapshot });
  const [bidError, setBidError] = useState<BidError | null>(null);
  const gate = bidGate({
    lotOpen: !!current && current.state === 'open',
    connected: !!wallet,
    signedIn: me.status === 'ready',
    hasPaddle: paddle.hasPaddle,
    leading: visitor.status === 'leading',
    paused,
  });

  const submitBid = useCallback(async (confirmed?: bigint): Promise<boolean> => {
    if (!current || nextAmount == null) return false;
    const amount = confirmed !== undefined && confirmed >= nextAmount ? confirmed : nextAmount; // what the panel showed, never less than the live next bid
    setBidError(null);
    setOptimistic({ lotId: current.id, amount });
    const r = await bid.submit(current.id, amount);
    if (r.ok) {
      setBidOn((s) => new Set(s).add(current.id));
      me.refresh();
      return true;
    }
    setOptimistic(null);
    setBidError(r.error);
    if (r.error.code && ['bid_too_low', 'lot_closed', 'lot_not_open', 'already_high_bidder', 'show_paused'].includes(r.error.code)) live.refresh();
    if (r.error.code === 'unauthenticated' || r.error.code === 'no_paddle') me.refresh();
    return false;
  }, [current, nextAmount, bid, me, live]);

  // A Telegram lot alert links here as /room/<show>?lot=<n>&bid=<amount>. It only pre-fills the confirmation of that lot: signed in and registered, the bid
  // panel opens with the amount; otherwise the Get ready sheet runs first and the panel follows. Nothing is placed until the person confirms and signs.
  const [prefill, setPrefill] = useState<BidPrefill | null>(null);
  const [linkNote, setLinkNote] = useState<number | null>(null);
  const prompted = useRef(false);
  const dropPrefill = useCallback(() => {
    setPrefill(null);
    try { history.replaceState(history.state, '', withoutPrefill(window.location.pathname, window.location.search, window.location.hash)); } catch { /* no history */ }
  }, []);
  useEffect(() => { try { setPrefill(parseBidPrefill(window.location.search)); } catch { /* no location */ } }, []);
  const target = prefill && current?.state === 'open' && current.lotNumber === prefill.lot;
  useEffect(() => {
    if (!prefill || !show || !current) return;
    if (!target) { // the lot is not open (any more, or not yet): the room just shows the current state, with one line saying so
      if (show.status === 'live' || show.status === 'ended') { setLinkNote(prefill.lot); dropPrefill(); }
      return;
    }
    if (gate === 'leading' || gate === 'no_lot') dropPrefill(); // nothing to confirm: already the high bidder, or the lot just stopped
  }, [prefill, target, show, current, gate, dropPrefill]);
  useEffect(() => { // a visitor who is not ready yet gets the Get ready sheet (after the wallet had a moment to reconnect by itself)
    if (!target || prompted.current || me.status === 'loading' || !(gate === 'connect' || gate === 'sign_in' || gate === 'register')) return undefined;
    const id = setTimeout(() => { prompted.current = true; setReadySheet(true); }, 1200);
    return () => clearTimeout(id);
  }, [target, gate, me.status]);
  useEffect(() => {
    if (linkNote == null) return undefined;
    const id = setTimeout(() => setLinkNote(null), 12_000);
    return () => clearTimeout(id);
  }, [linkNote]);

  // Connect, sign in and register are one path: the same sheet opens at whichever step is next.
  const onGate = useCallback((_g: 'connect' | 'sign_in' | 'register') => setReadySheet(true), []);

  const errTr = (e: BidError | null) => (e ? errorText(tr, e, usd) : null);
  const gateError = signIn.error ? errorText(tr, signIn.error, usd) : null;

  // --- settlement ------------------------------------------------------------------------------
  const [pay, setPay] = useState<PayTarget | null>(null);
  const { won, dismiss } = useWonLot(lots, bidOn);
  const { lost, dismiss: dismissLost } = useLostLot(lots, show?.isHouse ? bidOn : undefined);
  const lotNumbers = useMemo(() => new Map(lots.map((l) => [l.id, l.lotNumber])), [lots]);
  const agreedFor = useCallback((settlementId: string, fallback: string | null) => lots.find((l) => l.settlement?.id === settlementId)?.highBid ?? fallback, [lots]);
  // The account desk links here as /room/<show>?settle=<settlement>: open that signing sheet once, as soon as the settlement shows up as waiting on this wallet.
  const wantedSettle = useRef<string | null>(null);
  useEffect(() => { try { wantedSettle.current = new URLSearchParams(window.location.search).get('settle'); } catch { /* no location */ } }, []);
  useEffect(() => {
    const id = wantedSettle.current;
    const p = id ? me.me?.pending.find((x) => x.settlementId === id) : undefined;
    if (!id || !p) return;
    wantedSettle.current = null;
    setPay({ id, agreedGross: p.role === 'buyer' ? agreedFor(id, p.gross) : null });
  }, [me.me, agreedFor]);

  // --- feed and chat ---------------------------------------------------------------------------
  const [chat, setChat] = useState<FeedItem[]>([]);
  const feed = useMemo(() => {
    const events = feedFromEvents(live.events, { label, myPaddle, t: tr, isHouseBidder });
    return [...chat, ...events].sort((a, b) => b.ts - a.ts);
  }, [live.events, label, myPaddle, tr, chat, isHouseBidder]);
  const sendChat = useCallback((text: string) => {
    setChat((c) => [{ key: `chat-${Date.now()}-${c.length}`, kind: 'chat' as const, ts: Date.now(), who: myPaddle != null ? label(myPaddle) : t('feed.youFallback'), text }, ...c].slice(0, 100));
  }, [myPaddle, label, t]);

  // --- states before the room exists -----------------------------------------------------------
  const title = show?.title ?? t('topbar.title');
  if (live.status === 'notfound') {
    return (
      <Frame locale={locale} title={t('notFound.title')}>
        <p>{t('notFound.body')}</p>
        <Link href={`/${locale}/rooms`} className="hp-inline-link">{t('notFound.back')}</Link>
      </Frame>
    );
  }
  if ((live.status === 'error' || live.catalogueStatus === 'error') && (!snapshot || !catalogue)) {
    return (
      <Frame locale={locale} title={title}>
        <p>{t('unavailable')}</p>
        <button type="button" className="hp-sheet-primary" onClick={() => window.location.reload()}>{t('retry')}</button>
      </Frame>
    );
  }
  if (!snapshot || !catalogue || !show) {
    return <Frame locale={locale} title={title}><p>{t('loading')}</p></Frame>;
  }

  const startsAt = show.status === 'scheduled' && snapshot.show.scheduledAt && now != null
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(snapshot.show.scheduledAt))
    : null;
  const balance = me.me ? { usdc: me.me.funds.usdc } : null;

  return (
    <RoomShell
      locale={locale}
      title={show.title}
      status={show.status}
      kind={show.kind}
      demo={show.isHouse}
      seller={catalogue.show.sellerName}
      wallet={show.cluster === 'devnet'}
      banners={(
        <>
          {show.isHouse && <DemoNote kind={show.kind === 'timed' ? 'timed' : 'live'} />}
          {paused && snapshot && <PauseBanner msToResume={msToResume} msLeft={msLeft} used={snapshot.show.pause.used} max={snapshot.show.pause.max} />}
          {linkNote != null && <div className="ar-stale" role="status" data-testid="prefill-note">{t('prefill.notOpen', { number: linkNote })}</div>}
          {live.errorStreak >= 3 && <div className="ar-stale" role="status">{t('connection.stale')}</div>}
          {me.me && (
            <SettlementDesk
              pending={me.me.pending}
              lotNumbers={lotNumbers}
              onOpen={(id, role, gross) => setPay({ id, agreedGross: role === 'buyer' ? agreedFor(id, gross) : null })}
            />
          )}
        </>
      )}
    >
      <div className="ar-rostrum">
        <div className="ar-centre">
          <Stage
            show={show}
            lot={current}
            phase={phase}
            msLeft={msLeft}
            peakMs={peak.current.ms}
            extendedBy={extendedBy}
            msToNext={msToNext}
            jitterToken={jitter}
            solUsd={solUsd}
            startsAt={startsAt}
          />
          <NextStepLine
            cluster={normalizeCluster(show.cluster)}
            state={{
              wallet,
              me: me.status,
              usdc: me.me?.funds.usdc ?? null,
              hasPaddle: paddle.hasPaddle,
              show: show.status,
              standing: visitor.status === 'leading' ? 'leading' : visitor.status === 'outbid' ? 'outbid' : 'none',
              settlement: settlementFromPending(me.me?.pending),
            }}
          />
          <BidControl
            lot={current}
            gate={gate}
            busy={signIn.busy || paddle.busy}
            nextAmount={nextAmount}
            visitor={visitor}
            phase={phase}
            msToNext={msToNext}
            paddleNumber={myPaddle}
            practice={false}
            pending={bid.pending}
            pendingServer={!!optimistic && !bid.pending}
            error={errTr(bidError) ?? gateError}
            fundsShort={bidError?.code === 'insufficient_funds'}
            balance={balance}
            devnet={show.cluster === 'devnet'}
            locale={locale}
            solUsd={solUsd}
            prefill={target && prefill ? { amount: prefill.amount } : null}
            onPrefillShown={dropPrefill}
            onGate={onGate}
            onConfirm={submitBid}
            onDismissError={() => { setBidError(null); signIn.clearError(); }}
            onFunded={() => void me.refresh()}
          />
        </div>
        <CatalogueRail lots={lots} currentLotId={current?.id ?? null} showId={show.id} order={show.order} lotDurationS={show.kind === 'timed' ? undefined : catalogue.show.lotDurationS} locale={locale} />
        <EventRail feed={feed} onSendChat={sendChat} chatOn={chatOn} />
        <SideChat showId={show.id} locale={locale} currentLotNumber={current?.lotNumber ?? null} hasPaddle={myPaddle != null} onEnabledChange={setChatOn} onGetReady={() => setReadySheet(true)} />
      </div>
      <Assistant showId={show.id} locale={locale} lot={current ? { id: current.id, lotNumber: current.lotNumber, name: current.name } : null} />
      <Tour />

      <WinModal
        won={won}
        lots={lots}
        practice={false}
        demo={show.isHouse}
        cluster={cluster}
        locale={locale}
        solUsd={solUsd}
        dueAtBySettlement={dueAts.current}
        nowMs={now != null ? serverTime(offset, now) : null}
        onPay={(id) => { const w = won; dismiss(); setPay({ id, agreedGross: agreedFor(id, w ? w.amount.toString() : null) }); }}
        onClose={dismiss}
      />
      <DemoOutbidModal lot={lost} locale={locale} onClose={dismissLost} />
      {walletSheet && <WalletSheet onClose={() => setWalletSheet(false)} />}
      {readySheet && (
        <GetReadySheet
          wallet={wallet}
          meStatus={me.status}
          usdc={me.me?.funds.usdc ?? null}
          devnet={show.cluster === 'devnet'}
          signInBusy={signIn.busy}
          signInError={gateError}
          paddleBusy={paddle.busy}
          paddleError={paddle.error ? errorText(tr, paddle.error, usd) : null}
          onVerify={() => void signIn.signIn().then((ok) => { if (ok) markHintConfirmed('signin'); })}
          onRefresh={() => void me.refresh()}
          onStart={async (o) => { if (await paddle.register({ maxBid: o.maxBid, hours: o.hours })) { markHintConfirmed('paddle'); setReadySheet(false); } }}
          onClose={() => { setReadySheet(false); paddle.clearError(); signIn.clearError(); if (gate !== 'ready') dropPrefill(); }}
        />
      )}
      {pay && (
        <PayModal settlementId={pay.id} demoLot={show.isHouse ? lots.find((l) => l.settlement?.id === pay.id) ?? null : undefined} cluster={cluster} agreedGross={pay.agreedGross} locale={locale} serverOffset={offset} onFunded={() => void me.refresh()} onClose={() => setPay(null)} />
      )}
    </RoomShell>
  );
}
