'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import SignInGate from '@/components/sell/SignInGate';
import { useSession } from '@/components/auth/SessionProvider';
import { formatWait } from '@/components/sell/datetime';
import { IS_DEVNET } from '@/components/sell/chain-links';
import { useAssets } from '@/components/sell/useAssets';
import { claimFaucet } from './api';
import {
  ConsignmentsList, DeskBanner, DeskList, FundsPanel, PaddlesList, PagedList, WinsList, type FaucetUi,
} from './AccountViews';
import {
  BidSections, CardsView, CreditsView, DangerZone, NotificationsIntro, PricesView, RoomsList, SoldLots, WalletBalances,
} from './DashboardViews';
import { useActivity, useDesk, useLotNames, usePaddles } from './useAccountData';
import { useCredits, useMyRooms, useOwnProfile, useSummary, useWalletBalances, type CreditsState } from './useProfileData';
import type { PendingSettlement } from './desk';
import ProfileHeader from './ProfileHeader';
import ProfileEditor from './ProfileEditor';
import TelegramPanel from '@/components/telegram/TelegramPanel';
import { wantsTelegram } from '@/components/telegram/intent';
import '@/components/sell/sell.css';
import './account.css';

/** The sections of the profile page. `credits` only exists while AI is on and costs credits (see `visibleTabs`). */
export const TABS = ['profile', 'wallet', 'bids', 'payments', 'sales', 'prices', 'credits', 'notifications', 'account'] as const;
export type Tab = (typeof TABS)[number];

/**
 * Old links keep working: #desk, #todo and #tasks are Wins and payments, #activity and #bids are Bids, #wins is Wins and payments, #funds is Wallet,
 * #consignments is Sales, #paddles and #advanced are Bids (the bidder numbers are opened there), #telegram is Notifications.
 */
const HASH_TAB: Record<string, Tab> = {
  profile: 'profile', wallet: 'wallet', funds: 'wallet', bids: 'bids', activity: 'bids', paddles: 'bids', advanced: 'bids',
  payments: 'payments', wins: 'payments', todo: 'payments', tasks: 'payments', desk: 'payments',
  sales: 'sales', consignments: 'sales', prices: 'prices', credits: 'credits', notifications: 'notifications', telegram: 'notifications', account: 'account', danger: 'account',
};
const HASH_PADDLES = new Set(['advanced', 'paddles']);
const bare = (hash: string) => hash.replace(/^#/, '');

/** The tab a url hash names, or null when it names none (the page then opens Wins and payments if something waits, else Profile). */
export const tabFromHash = (hash: string): Tab | null => HASH_TAB[bare(hash)] ?? null;
export const advancedFromHash = (hash: string): boolean => HASH_PADDLES.has(bare(hash));
/** AI credits are hidden while the AI feature is off and while AI is free; every other tab is always there. */
export const visibleTabs = (credits: CreditsState['status']): Tab[] => TABS.filter((t) => t !== 'credits' || credits === 'ready');

function BidsSection({ openPaddles }: { openPaddles: boolean }) {
  const t = useTranslations('account');
  const { state, reload, loadMore } = useActivity('bids');
  const { state: paddles, reload: reloadPaddles, release } = usePaddles();
  const [open, setOpen] = useState(openPaddles);
  return (
    <>
      <PagedList state={state} onRetry={() => void reload()} onMore={() => void loadMore()} empty={t('bids.empty')}>{(items) => <BidSections items={items} />}</PagedList>
      <details className="sl-adv" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="account-advanced">
        <summary>{t('bids.paddlesTitle')}</summary>
        <div className="sl-adv-body">
          {open && <PaddlesList state={paddles} onRetry={() => void reloadPaddles()} onRelease={(r) => void release(r.show.id)} />}
        </div>
      </details>
    </>
  );
}

function PaymentsTab({ pending }: { pending: PendingSettlement[] }) {
  const t = useTranslations('account');
  const views = useDesk(pending);
  const names = useLotNames(pending);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const { state, reload, loadMore } = useActivity('wins');
  return (
    <>
      <h2 className="sl-h3">{t('payments.openTitle')}</h2>
      <DeskList pending={pending} views={views} nowMs={nowMs} names={names} />
      <h2 className="sl-h3">{t('payments.purchasesTitle')}</h2>
      <PagedList state={state} onRetry={() => void reload()} onMore={() => void loadMore()} empty={t('wins.empty')}>{(items) => <WinsList items={items} pending={pending} />}</PagedList>
    </>
  );
}

function SalesTab() {
  const t = useTranslations('account');
  const rooms = useMyRooms();
  const consignments = useActivity('consignments');
  const summary = useSummary();
  return (
    <>
      <section aria-labelledby="rooms-heading">
        <h2 className="sl-h3" id="rooms-heading">{t('sales.roomsTitle')}</h2>
        {rooms.state.status === 'loading' && <p className="sl-note" role="status">{t('loading')}</p>}
        {rooms.state.status === 'error' && <div className="sl-warn" role="alert"><p>{t('loadError')}</p><button type="button" className="sl-btn" onClick={() => void rooms.reload()}>{t('retry')}</button></div>}
        {rooms.state.status === 'ready' && (
          <>
            <RoomsList shows={rooms.state.data.shows} />
            {rooms.state.data.nextCursor && <button type="button" className="sl-btn" data-testid="load-more" disabled={rooms.state.data.more} onClick={() => void rooms.loadMore()}>{rooms.state.data.more ? t('loading') : t('loadMore')}</button>}
          </>
        )}
      </section>
      <h2 className="sl-h3">{t('sales.soldTitle')}</h2>
      <SoldLots summary={summary.state} onRetry={summary.reload} />
      <h2 className="sl-h3">{t('sales.cardsTitle')}</h2>
      <PagedList state={consignments.state} onRetry={() => void consignments.reload()} onMore={() => void consignments.loadMore()} empty={t('consignments.empty')}>{(items) => <ConsignmentsList items={items} />}</PagedList>
    </>
  );
}

function WalletTab() {
  const s = useSession();
  const locale = useLocale();
  const balances = useWalletBalances();
  const assets = useAssets();
  const [ui, setUi] = useState<FaucetUi>({ kind: 'idle' });
  const funds = s.me ? s.me.funds : { usdc: null };

  async function claim() {
    setUi({ kind: 'busy' });
    const r = await claimFaucet();
    if (r.ok) {
      setUi({ kind: 'done', amount: r.data.amount, signature: r.data.signature });
      void s.refresh();
      balances.reload();
    } else setUi({ kind: 'fail', code: r.code, wait: r.retryAfterS ? formatWait(r.retryAfterS, locale) : undefined });
  }
  return (
    <>
      <WalletBalances wallet={balances.state} available={funds.usdc} onRetry={balances.reload} />
      <FundsPanel devnet={IS_DEVNET} funds={funds} ui={ui} onClaim={() => void claim()} />
      <CardsView state={assets.state} onRetry={() => void assets.reload()} />
    </>
  );
}

function AccountTab() {
  const s = useSession();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <DangerZone
      confirming={confirming} busy={busy} onAsk={() => setConfirming(true)} onCancel={() => setConfirming(false)}
      onConfirm={() => { setBusy(true); void s.signOut().finally(() => { setBusy(false); setConfirming(false); }); }}
    />
  );
}

function Inner() {
  const t = useTranslations('account');
  const s = useSession();
  // null = the user did not pick one: show Wins and payments while something waits for them, Profile otherwise.
  const [picked, setPicked] = useState<Tab | null>(null);
  const [paddlesOpen, setPaddlesOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const profile = useOwnProfile();
  const credits = useCredits();
  const summaryForTabs = visibleTabs(credits.status);

  useEffect(() => {
    const read = () => {
      const { hash, search } = window.location;
      // ?telegram=open (the link the bot and the pages use) lands on Notifications, where the panel scrolls to itself and takes focus.
      setPicked(wantsTelegram(search, hash) ? 'notifications' : tabFromHash(hash));
      if (advancedFromHash(hash)) setPaddlesOpen(true);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  // Keep `pending` and the balance current while the page is open (the header and banner read the same store).
  const { refresh } = s;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const choose = useCallback((next: Tab) => {
    setPicked(next);
    history.replaceState(null, '', `#${next}`);
  }, []);

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = summaryForTabs.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = summaryForTabs[to];
    choose(next);
    listRef.current?.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
  };

  if (s.status !== 'signed-in' || !s.me) return null;
  const me = s.me;
  const pending = me.pending as PendingSettlement[];
  const wanted = picked ?? (pending.length > 0 ? 'payments' : 'profile');
  const tab: Tab = summaryForTabs.includes(wanted) ? wanted : 'profile';

  return (
    <>
      <ProfileHeader profile={profile.state} wallet={me.wallet} />
      <DeskBanner pending={pending} onOpen={tab === 'payments' ? undefined : () => choose('payments')} />
      <div className="sl-tabs" role="tablist" aria-label={t('tabsLabel')} ref={listRef}>
        {summaryForTabs.map((id, i) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="sl-tab"
            data-testid={`tab-${id}`}
            onClick={() => choose(id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t(`tabs.${id}`)}
            {id === 'payments' && pending.length > 0 && <span className="sl-count" aria-label={t('desk.openCount', { count: pending.length })}>{pending.length}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="sl-panel" data-testid={`panel-${tab}`}>
        {tab === 'profile' && <ProfileEditor profile={profile.state} onProfile={profile.set} />}
        {tab === 'wallet' && <WalletTab />}
        {tab === 'bids' && <BidsSection openPaddles={paddlesOpen} />}
        {tab === 'payments' && <PaymentsTab pending={pending} />}
        {tab === 'sales' && <SalesTab />}
        {tab === 'prices' && <PricesTab />}
        {tab === 'credits' && credits.status === 'ready' && <CreditsView data={credits.data} />}
        {tab === 'notifications' && (
          <>
            <NotificationsIntro onPayments={() => choose('payments')} />
            <TelegramPanel />
          </>
        )}
        {tab === 'account' && <AccountTab />}
      </div>
    </>
  );
}

function PricesTab() {
  const summary = useSummary();
  return <PricesView summary={summary.state} onRetry={summary.reload} />;
}

/** A visitor who followed a Telegram link but is not signed in yet: say what happens after sign-in (the panel then acts on the same URL). */
function TelegramIntentNote() {
  const t = useTranslations('telegram');
  const s = useSession();
  const [wants, setWants] = useState(false);
  useEffect(() => { setWants(wantsTelegram(window.location.search, window.location.hash)); }, []);
  if (!wants || s.status === 'signed-in') return null;
  return <p className="sl-note" data-testid="telegram-intent-note">{t('ui.signInFirst')}</p>;
}

export default function Account() {
  const t = useTranslations('account');
  return (
    <div className="hp sl">
      <header className="sl-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="sl-h1">{t('title')}</h1>
        <p className="sl-lede">{t('lede')}</p>
      </header>
      <TelegramIntentNote />
      <SignInGate>
        <Inner />
      </SignInGate>
    </div>
  );
}
