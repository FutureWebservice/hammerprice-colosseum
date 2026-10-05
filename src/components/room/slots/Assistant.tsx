'use client';

/**
 * Slot: the AI assistant of the room (owner: AI, FEATURE_AI). Mounted by AuctionRoom.tsx after the rostrum. It renders nothing while the feature is off.
 *
 * A pill button at the bottom left of the room (next to the chat button, same size and shape: launchers.css) opens the SAME agent as the /ai page:
 * the same chat component, the same POST /api/ai/agent, the same wallet requirement (a visitor without a wallet sees the connect card). It is the RIGHT sidebar
 * of the room on a desktop (the chat is the left one, both can be open) and a full screen sheet on a phone. It knows which lot is on the block: that lot is sent as DATA (a lot id and a name, the
 * server tags it and never reads it as an instruction), so "bid up to 50 USDC on this lot" prepares a bid proposal that links into THIS room.
 *
 * History: the conversation is shared with the /ai page on purpose (one local key per wallet, history.ts), so it continues between the room and
 * the page. The drawer stays mounted once opened, so an answer on its way is not lost when it is closed.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import AgentChat from '@/components/ai/AgentChat';
import { useAiFeatureOn } from '@/components/ai/useAiCredits';
import { useSidebar } from '../sidebars';
import '../launchers.css';

export interface AssistantProps {
  showId: string;
  locale: string;
  /** The lot on the block (public id, number, name), or null. */
  lot?: { id: string; lotNumber: number; name: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function Assistant(props: AssistantProps) {
  return useAiFeatureOn() ? <RoomAssistant {...props} /> : null; // nothing at all while the feature is off
}

export function RoomAssistant({ showId, locale, lot = null }: AssistantProps) {
  const t = useTranslations('ai');
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false); // opened once: the chat stays mounted from then on
  const launcher = useRef<HTMLButtonElement>(null);

  const panel = useRef<HTMLElement>(null);
  const close = () => setOpen(false);
  // Escape, Tab on a phone (the full screen sheet), one sidebar at a time below 1280 px, and the focus back to the launcher once it is shown again (a phone hides it while open)
  useSidebar({ id: 'assistant', open, close, panel, launcher, focusIn: false });
  const roomLot = lot && UUID.test(lot.id) ? { lotId: lot.id, lotNumber: lot.lotNumber, name: lot.name } : null;
  return (
    <div className="hp-assist" data-testid="ai-ask-room" data-show={showId}>
      <button ref={launcher} type="button" className="hp-launch hp-launch--ai" aria-expanded={open} aria-controls="hp-assist-drawer" aria-label={open ? t('assistant.close') : t('assistant.open')} onClick={() => { setSeen(true); setOpen((o) => !o); }} data-testid="ai-ask-open">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" /></svg>
        <span>{t('assistant.launch')}</span>
      </button>
      {open && <div className="hp-assist-scrim" onClick={close} aria-hidden="true" />}
      {seen && (
        <aside ref={panel} id="hp-assist-drawer" data-hp-sidebar="assistant" className="hp-assist-drawer" role="dialog" aria-label={t('assistant.title')} hidden={!open} data-testid="ai-ask-panel">
          <AgentChat locale={locale} variant="drawer" roomLot={roomLot} showId={showId} active={open} onClose={close} />
        </aside>
      )}
    </div>
  );
}
