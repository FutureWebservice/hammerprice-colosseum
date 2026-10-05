'use client';

/**
 * Slot: the room chat (owner: CHAT, FEATURE_CHAT). Mounted by AuctionRoom.tsx after the event rail.
 *
 * The chat is PRE-MODERATED: what a viewer writes waits for the room operator and only approved messages are public. While the feature is off,
 * or before the first answer, this renders nothing, so the room looks exactly as before. When it is on, a "Chat" pill sits at the
 * bottom left of the screen (next to the assistant button, launchers.css) and opens the panel as the LEFT sidebar of the room (a full screen sheet on a
 * phone), so it never sits under the assistant drawer on the right. While it is open the same button reads "Close chat". A closed panel changes no layout.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import ChatSkeleton from '@/components/chat/ChatSkeleton';
import ModerationView from '@/components/chat/ModerationView';
import { type QueueFilter } from '@/components/chat/chatClient';
import ModToast from '@/components/chat/ModToast';
import { deepLink } from '@/components/chat/toastLogic';
import { useChat } from '@/components/chat/useChat';
import '@/components/chat/chat.css';
import { useSidebar } from '@/components/room/sidebars';
import '@/components/room/launchers.css';

export interface SideChatProps {
  showId: string;
  locale: string;
  /** The lot on the block, for the "this lot only" filter; null when none. */
  currentLotNumber: number | null;
  /** The viewer has a paddle in this show (needed to write). */
  hasPaddle: boolean;
  /** Told once the chat answers whether it is on, so the room can hide the older local-only message box while it is. */
  onEnabledChange?: (on: boolean) => void;
  /** Opens the room's "get ready" sheet (connect, sign in, bidder number); the two cards of a viewer who cannot write offer it. */
  onGetReady?: () => void;
}

// The panel's own code (the list, the composer, the report dialog) loads on the first open; the skeleton fills the sidebar meanwhile.
const ChatPanel = dynamic(() => import('@/components/chat/ChatPanel'), { ssr: false, loading: () => <ChatSkeleton /> });

type Chat = ReturnType<typeof useChat>;

export default function SideChat({ showId, locale, currentLotNumber, hasPaddle, onEnabledChange, onGetReady }: SideChatProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'chat' | 'mod'>('chat');
  const [filter, setFilter] = useState<QueueFilter>('pending');
  const [focusId, setFocusId] = useState<string | null>(null);
  const chat = useChat({ showId, open, hasPaddle, moderating: open && tab === 'mod', filter });

  const on = chat.enabled === true;
  useEffect(() => { onEnabledChange?.(on); }, [on, onEnabledChange]);

  if (!on) return null; // off, or no answer yet: the room is unchanged
  return (
    <Shell chat={chat} showId={showId} locale={locale} currentLotNumber={currentLotNumber} hasPaddle={hasPaddle} onGetReady={onGetReady}
      open={open} setOpen={setOpen} tab={tab} setTab={setTab} filter={filter} setFilter={setFilter} focusId={focusId} setFocusId={setFocusId} />
  );
}

export function Shell({ chat, showId, locale, currentLotNumber, hasPaddle, onGetReady, open, setOpen, tab, setTab, filter, setFilter, focusId, setFocusId }: SideChatProps & {
  focusId: string | null; setFocusId: (id: string | null) => void;
  chat: Chat; open: boolean; setOpen: (v: boolean | ((o: boolean) => boolean)) => void; tab: 'chat' | 'mod'; setTab: (t: 'chat' | 'mod') => void; filter: QueueFilter; setFilter: (f: QueueFilter) => void;
}) {
  const t = useTranslations('chat');
  const waiting = chat.operator ? chat.queue?.counts.pending ?? 0 : 0;
  const badge = chat.operator ? (waiting > 0 ? t('launcher.moderate', { count: waiting }) : null) : chat.unread > 0 ? t('launcher.unread', { count: chat.unread }) : null;
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const toggle = () => { setOpen((v) => !v); chat.markRead(); setFocusId(null); };
  useSidebar({ id: 'chat', open, close: () => { setOpen(false); chat.markRead(); setFocusId(null); }, panel, launcher });
  const openOn = (id: string) => { const d = deepLink(id); setOpen(d.open); setTab(d.tab); setFilter(d.filter); setFocusId(d.focusId); chat.markRead(); chat.refreshQueue(); };

  return (
    <div className="hc-root">
      <ModToast showId={showId} operator={chat.operator} enabled paused={open && tab === 'mod'} onOpen={openOn} onChanged={() => { chat.refreshQueue(); chat.refresh(); }} />
      <div className="hp-sr" aria-live="polite">{chat.announce ? t('announce', { count: chat.announce.count }) : ''}</div>
      <button ref={launcher} type="button" data-testid="chat-launcher" className="hp-launch hp-launch--chat" onClick={toggle} aria-expanded={open} aria-controls="hc-panel" aria-label={open ? t('launcher.close') : t('launcher.openLabel')}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>
        <span>{open ? t('launcher.closeShort') : t('launcher.open')}</span>
        {!open && badge && <span className="hc-badge">{badge}</span>}
      </button>
      {open && (
        <aside ref={panel} id="hc-panel" data-testid="chat-panel" data-hp-sidebar="chat" tabIndex={-1} className="hc-panel" aria-label={t('panel.title')}>
          <header className="hc-head">
            <h2 className="hc-title">{t('panel.title')}</h2>
            <button type="button" className="hc-x" onClick={toggle} aria-label={t('launcher.close')}>×</button>
          </header>
          {chat.operator && (
            <div className="hc-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'chat'} className={`hc-tab${tab === 'chat' ? ' is-on' : ''}`} onClick={() => setTab('chat')}>{t('panel.tabChat')}</button>
              <button type="button" role="tab" data-testid="chat-tab-mod" aria-selected={tab === 'mod'} className={`hc-tab${tab === 'mod' ? ' is-on' : ''}`} onClick={() => setTab('mod')}>
                {t('panel.tabModerate')}{waiting > 0 && <span className="hc-count">{waiting}</span>}
              </button>
            </div>
          )}
          {chat.operator && tab === 'mod' ? (
            <div className="hc-scroll">
              <ModerationView showId={showId} queue={chat.queue} filter={filter} onFilter={setFilter} onChanged={() => { chat.refreshQueue(); chat.refresh(); }} locale={locale} focusId={focusId} />
            </div>
          ) : (
            <ChatPanel showId={showId} locale={locale} messages={chat.messages} mine={chat.mine} signedIn={chat.signedIn} hasPaddle={hasPaddle}
              operator={chat.operator} currentLotNumber={currentLotNumber} send={chat.send} onGetReady={onGetReady} />
          )}
        </aside>
      )}
    </div>
  );
}
