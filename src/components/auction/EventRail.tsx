'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import Term from '@/components/glossary/Term';
import type { FeedItem } from './types';

type Usd = (u: string | null | undefined) => string;

/**
 * The words that carry this product, as glossary terms (one source, the same words as the FAQ): each opens a one-sentence card.
 * The disclosure starts closed so it never crowds the feed on a phone.
 */
// Not inside the bid panel or the payment sheet: those are aria-modal dialogs, and a card that opens outside a modal dialog cannot be reached by a screen reader.
const ROOM_TERMS = ['usdc', 'paddle', 'bid', 'reserve', 'hammer', 'hammerPrice', 'antiSniping', 'networkFee', 'settlement', 'memo'] as const;

function Glossary({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <details className="ar-glossary">
      <summary className="ar-glossary-head">{t('glossary.title')}</summary>
      <ul className="ar-glossary-list is-terms" data-testid="room-terms">
        {ROOM_TERMS.map((id) => <li key={id}><Term id={id} /></li>)}
      </ul>
    </details>
  );
}

function Row({ item, t, usd, boundary }: { item: FeedItem; t: ReturnType<typeof useTranslations>; usd: Usd; boundary: boolean }) {
  const boundaryCls = boundary ? ' is-lot-boundary' : '';

  if (item.kind === 'bid') {
    return (
      <li className={`ar-feed-row is-bid${boundaryCls}`}>
        <span className="ar-feed-who">
          {/* Bidders appear as paddle labels only. The viewer's own rows get a brass badge instead. */}
          {item.mine ? <span className="ar-feed-mine">{t('feed.buyerYou')}</span> : <b>{item.who ?? t('feed.bidderFallback')}</b>}
          {item.lotNumber != null ? <> · {t('feed.lotInline', { number: item.lotNumber })}</> : null}
        </span>
        <span className="ar-feed-amt">{usd(item.amount)}</span>
      </li>
    );
  }
  if (item.kind === 'chat') {
    return (
      <li className={`ar-feed-row${boundaryCls}`}>
        <span className="ar-feed-who">
          <b>{item.who ?? t('feed.youFallback')}</b>{' '}
          <span className="ar-feed-chat-text">{item.text}</span>
        </span>
      </li>
    );
  }
  if (item.kind === 'sold') {
    return (
      <li className={`ar-feed-row is-hammer${boundaryCls}`}>
        <span className="ar-feed-note">{item.text}</span>
      </li>
    );
  }
  // opened / going once / going twice / passed / withdrawn / note: the room's own voice, ruled across the column.
  const isCall = item.kind === 'going-once' || item.kind === 'going-twice';
  return (
    <li className={`ar-feed-row is-rule${isCall ? ' is-call' : ''}${boundaryCls}`}>
      <span className="ar-feed-rule-text">{item.text}</span>
    </li>
  );
}

/**
 * `chatOn`: the real, pre-moderated room chat is running (FEATURE_CHAT). The older local-only box (writes to the writer's own screen only)
 * is then hidden so the room has one chat, not two. Off or unknown (the default) keeps the box exactly as before.
 */
export default function EventRail({ feed, onSendChat, chatOn = false }: { feed: FeedItem[]; onSendChat: (text: string) => void; chatOn?: boolean }) {
  const t = useTranslations('room');
  const usd = useUsd();
  const [draft, setDraft] = useState('');
  const inputId = useId();

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSendChat(text);
    setDraft('');
  };

  return (
    <aside className="ar-feed" aria-label={t('a11y.feed')}>
      <h2 className="ar-feed-head">{t('feed.title')}</h2>
      <Glossary t={t} />
      <div className="ar-feed-list" tabIndex={0} role="region" aria-label={t('feed.title')}>
        {feed.length === 0 && <div className="ar-feed-empty">{t('feed.empty')}</div>}
        {feed.length > 0 && (
          <ul className="ar-feed-items">
            {feed.map((item, i) => {
              // Newest first: a row opens an older lot's block when its lot number differs from the row just above it.
              const newer = feed[i - 1];
              const boundary = !!newer && newer.lotNumber != null && item.lotNumber != null && newer.lotNumber !== item.lotNumber;
              return <Row key={item.key} item={item} t={t} usd={usd} boundary={boundary} />;
            })}
          </ul>
        )}
      </div>
      {!chatOn && (
        <>
          <form className="ar-composer" data-testid="local-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label htmlFor={inputId} className="hp-sr">{t('a11y.chatLabel')}</label>
            <input id={inputId} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('feed.placeholder')} maxLength={280} />
            <button type="submit">{t('feed.send')}</button>
          </form>
          <div className="ar-composer-note">{t('feed.note')}</div>
        </>
      )}
    </aside>
  );
}
