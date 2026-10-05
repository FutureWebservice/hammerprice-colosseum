'use client';

/**
 * LEGACY. The product's one DEMO room is the house room (/room/house), which takes real signed devnet bids; this simulated practice room
 * is no longer linked from the nav, the landing page, the rooms index or the docs, and /rooms does not list it. The route and this component
 * stay so old links keep working.
 *
 * The practice room: the ONE place the simulation lives. Used only for the legacy demo show id (src/lib/demo-show.ts).
 * Bidders, bids and the clock are simulated client-side from wall-clock time (demo-clock.ts); nothing is signed,
 * sent or charged. The room says so: a label next to the live state and a popover on what is real and what is not.
 * A visitor with no wallet can bid through a guest paddle; a connected wallet works too but still signs nothing.
 *
 * Real rooms never import this file or any demo-* module.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useWallet } from '@solana/wallet-adapter-react';
import type { ShowDetail } from '@/contracts';
import { fetchCatalogue, LiveError } from '@/lib/client/live';
import PracticeBadge from '@/components/room/PracticeBadge';
import RoomShell from '@/components/room/RoomShell';
import WalletSheet from '@/components/room/WalletSheet';
import BidControl from './BidControl';
import CatalogueRail from './CatalogueRail';
import EventRail from './EventRail';
import Stage from './Stage';
import WinModal, { useWonLot } from './WinModal';
import Tour from '@/components/tour/Tour';
import useDemoRoom from './useDemoRoom';
import { bidGate, buildRoomLots, nextBidOf } from './model';
import type { FeedItem, RoomShow } from './types';

const GUEST = 'guest-paddle';

export default function PracticeRoom({ showId, solUsd = null }: { showId: string; solUsd?: number | null }) {
  const locale = useLocale();
  const t = useTranslations('room');
  const { publicKey } = useWallet();
  const visitor = publicKey?.toBase58() ?? GUEST;

  const [catalogue, setCatalogue] = useState<ShowDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [guest, setGuest] = useState(false);
  const [walletSheet, setWalletSheet] = useState(false);
  const [chat, setChat] = useState<FeedItem[]>([]);
  const [jitter, setJitter] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    fetchCatalogue(showId, (...a) => fetch(...a), ctl.signal)
      .then((c) => { setCatalogue(c); setStatus('ready'); })
      .catch((e) => { if (!ctl.signal.aborted) setStatus(e instanceof LiveError && e.kind === 'not_found' ? 'notfound' : 'error'); });
    return () => ctl.abort();
  }, [showId]);

  const catalogueLots = useMemo(() => (catalogue ? buildRoomLots(catalogue, null, (n) => String(n), null) : null), [catalogue]);
  const demo = useDemoRoom(catalogueLots);
  const lots = useMemo(() => demo?.lots ?? [], [demo]);
  const current = useMemo(() => (demo ? (lots.find((l) => l.id === demo.currentLotId) ?? lots[0] ?? null) : null), [demo, lots]);
  const nextAmount = nextBidOf(current);
  const phase = demo?.phase ?? 'gap';
  const { won, dismiss } = useWonLot(lots, demo?.participatedLotIds);

  useEffect(() => { setJitter((j) => j + 1); }, [current?.id, current?.highBid]);

  const show: RoomShow | null = catalogue
    ? { id: catalogue.show.id, title: catalogue.show.title, status: catalogue.show.status, cluster: null, isHouse: false, settlementMode: 'none' }
    : null;

  const gate = bidGate({ lotOpen: !!current && current.state === 'open', connected: guest || !!publicKey, signedIn: true, hasPaddle: true, leading: demo?.visitor.status === 'leading' });
  const confirm = useCallback(async () => {
    if (nextAmount != null) demo?.placeBid(nextAmount, visitor);
    return true;
  }, [nextAmount, demo, visitor]);
  const sendChat = useCallback((text: string) => {
    setChat((c) => [{ key: `chat-${Date.now()}-${c.length}`, kind: 'chat' as const, ts: Date.now(), who: t('feed.youFallback'), text }, ...c].slice(0, 100));
  }, [t]);
  const feed = useMemo(() => [...chat, ...(demo?.feed ?? [])].sort((a, b) => b.ts - a.ts), [chat, demo]);

  const pill = <PracticeBadge locale={locale} />;

  if (status === 'notfound' || status === 'error') {
    return (
      <RoomShell locale={locale} title={t(status === 'notfound' ? 'notFound.title' : 'topbar.title')} status={null} pill={pill}>
        <div className="ar-notice">
          <p>{t(status === 'notfound' ? 'notFound.body' : 'unavailable')}</p>
          <Link href={`/${locale}/rooms`} className="hp-inline-link">{t('notFound.back')}</Link>
        </div>
      </RoomShell>
    );
  }
  if (!show) {
    return <RoomShell locale={locale} title={t('topbar.title')} status={null} pill={pill}><div className="ar-notice"><p>{t('loading')}</p></div></RoomShell>;
  }

  return (
    <RoomShell locale={locale} title={show.title} status={show.status} pill={pill}>
      <div className="ar-rostrum">
        <div className="ar-centre">
          <Stage show={show} lot={current} phase={phase} msLeft={null} peakMs={0} extendedBy={0} msToNext={demo?.msToNext ?? null} jitterToken={jitter} solUsd={solUsd} />
          <BidControl
            lot={current}
            gate={gate}
            busy={false}
            nextAmount={nextAmount}
            visitor={demo?.visitor ?? { status: 'idle', lastAmount: null, outbidBy: null, hammer: null }}
            phase={phase}
            msToNext={demo?.msToNext ?? null}
            paddleNumber={null}
            practice
            pending={false}
            pendingServer={false}
            error={null}
            balance={null}
            devnet={false}
            locale={locale}
            solUsd={solUsd}
            onGate={() => setWalletSheet(true)}
            onConfirm={confirm}
            onHold={demo?.setHold}
            onDismissError={() => undefined}
          />
        </div>
        <CatalogueRail lots={lots} currentLotId={current?.id ?? null} />
        <EventRail feed={feed} onSendChat={sendChat} />
      </div>
      <Tour />
      <WinModal won={won} lots={lots} practice cluster={null} locale={locale} solUsd={solUsd} onPay={() => undefined} onClose={dismiss} />
      {walletSheet && <WalletSheet onClose={() => setWalletSheet(false)} onGuest={() => setGuest(true)} />}
    </RoomShell>
  );
}
