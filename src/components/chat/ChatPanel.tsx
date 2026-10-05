'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ChatMessage, ChatOwnMessage } from '@/contracts';
import { ChatError, errorKey, readBlocked, writeBlocked } from './chatClient';
import ReportDialog from './ReportDialog';

const MAX = 200;

export interface ChatPanelProps {
  showId: string;
  locale: string;
  messages: ChatMessage[];
  mine: ChatOwnMessage[];
  signedIn: boolean;
  hasPaddle: boolean;
  operator: boolean;
  currentLotNumber: number | null;
  send: (body: string, lotNumber: number | null) => Promise<void>;
  /** Opens the room's "get ready" sheet (connect the wallet, sign in, get a bidder number): the button of the two cards a viewer who cannot write sees. */
  onGetReady?: () => void;
}

/** The public chat: approved messages, the viewer's own waiting or rejected ones, and the composer. Plain text only, never a link, never HTML. */
export default function ChatPanel({ showId, locale, messages, mine, signedIn, hasPaddle, operator, currentLotNumber, send, onGetReady }: ChatPanelProps) {
  const t = useTranslations('chat');
  const [lotOnly, setLotOnly] = useState(false);
  const [blocked, setBlocked] = useState<number[]>([]);
  const [reporting, setReporting] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }), [locale]);

  useEffect(() => { setBlocked(readBlocked(showId)); }, [showId]); // kept in memory for this page (chatClient.ts)

  const visible = messages.filter((m) => {
    if (lotOnly && currentLotNumber != null && m.lotNumber != null && m.lotNumber !== currentLotNumber) return false;
    return true;
  });

  // Stay at the bottom while the viewer is at the bottom; leave the scroll alone once they scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, mine.length]);

  const toggleBlock = (paddle: number) => {
    const next = blocked.includes(paddle) ? blocked.filter((p) => p !== paddle) : [...blocked, paddle];
    setBlocked(next);
    writeBlocked(showId, next);
  };

  const canWrite = signedIn && (hasPaddle || operator);
  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      await send(body, lotOnly && currentLotNumber != null ? currentLotNumber : null);
      setDraft('');
      setSent(!operator);
      stick.current = true;
    } catch (e) {
      setError(t(`error.${errorKey(e instanceof ChatError ? e : null)}`));
    } finally {
      setBusy(false);
    }
  };

  const label = (m: ChatMessage): string => (m.role === 'house' ? t('panel.house') : m.role === 'seller' ? t('panel.seller') : t('panel.bidder', { number: m.paddle ?? 0 }));
  /** The chosen display name first, the role or bidder number after it ("Anna, Bidder 7"); the bidder number alone when no name was set. */
  const who = (m: ChatMessage): string => (m.name ? t('panel.named', { name: m.name, label: label(m) }) : label(m));

  return (
    <>
      {!canWrite && (
        <section className="hc-gate" data-testid="chat-cannot-write" data-state={signedIn ? 'paddle' : 'wallet'} aria-labelledby="hc-gate-title">
          <h3 id="hc-gate-title" className="hc-gate-title">{signedIn ? t('panel.readyTitle') : t('panel.connectTitle')}</h3>
          <p className="hc-note">{signedIn ? t('panel.needPaddle') : t('panel.signIn')}</p>
          {onGetReady && <button type="button" data-testid="chat-get-ready" className="hc-send hc-gate-btn" onClick={onGetReady}>{signedIn ? t('panel.readyCta') : t('panel.connectCta')}</button>}
        </section>
      )}

      <div className="hc-tools">
        {currentLotNumber != null && (
          <label className="hc-check">
            <input type="checkbox" checked={lotOnly} onChange={(e) => setLotOnly(e.target.checked)} />
            {t('panel.lotOnly')}
          </label>
        )}
      </div>

      <div
        ref={listRef}
        className="hc-list"
        role="log"
        aria-label={t('panel.title')}
        tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      >
        {visible.length === 0 && mine.length === 0 && <p className="hc-empty">{t('panel.empty')}</p>}
        <ul className="hc-msgs">
          {visible.map((m) => {
            const hidden = m.paddle != null && blocked.includes(m.paddle);
            if (hidden) {
              // A bidder the viewer hid: the text is not shown (and not read out), one tap brings it back. Local to this page.
              return (
                <li key={m.id} data-testid="chat-msg" className="hc-msg is-hidden">
                  <p className="hc-note">{who(m)}: {t('panel.hiddenNotice')}</p>
                  <div className="hc-msg-actions">
                    <button type="button" data-testid="chat-hide" className="hc-link" onClick={() => toggleBlock(m.paddle!)}>{t('panel.unhide')}</button>
                  </div>
                </li>
              );
            }
            return (
              <li key={m.id} data-testid="chat-msg" className={`hc-msg is-${m.role}${m.source === 'assistant' ? ' is-ai' : ''}`}>
                <div className="hc-msg-head">
                  <b className="hc-who">{who(m)}</b>
                  {m.source === 'assistant' && <span className="hc-ai" title={t('panel.assistantTitle')}>{t('panel.assistant')}</span>}
                  {m.lotNumber != null && <span className="hc-lot">{t('panel.lotLabel', { number: m.lotNumber })}</span>}
                  <time className="hc-time" dateTime={m.at}>{time.format(new Date(m.at))}</time>
                </div>
                <p className="hc-text">{m.body}</p>
                <div className="hc-msg-actions">
                  <button type="button" data-testid="chat-report" className="hc-link" onClick={() => setReporting(m.id)}>{t('panel.report')}</button>
                  {m.paddle != null && <button type="button" data-testid="chat-hide" className="hc-link" onClick={() => toggleBlock(m.paddle!)}>{t('panel.hide')}</button>}
                </div>
              </li>
            );
          })}
          {mine.map((m) => (
            <li key={m.id} data-testid="chat-own" data-status={m.status} className={`hc-msg is-own is-${m.status}`}>
              <p className="hc-text">{m.body}</p>
              <p className="hc-note">{m.status === 'pending' ? t('panel.waiting') : m.reason ? t('panel.rejected', { reason: m.reason }) : t('panel.rejectedPlain')}</p>
            </li>
          ))}
        </ul>
      </div>

      {canWrite ? (
        <form className="hc-composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label htmlFor="hc-input" className="hp-sr">{t('composer.label')}</label>
          <textarea
            id="hc-input"
            data-testid="chat-input"
            value={draft}
            rows={2}
            maxLength={MAX}
            placeholder={t('composer.placeholder')}
            onChange={(e) => { setDraft(e.target.value); setError(null); setSent(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          />
          <div className="hc-composer-row">
            <span className="hc-counter" aria-hidden="true">{t('composer.counter', { count: draft.length, max: MAX })}</span>
            <button type="submit" data-testid="chat-send" className="hc-send" disabled={busy || draft.trim().length === 0}>{busy ? t('composer.sending') : t('composer.send')}</button>
          </div>
          {error && <p className="hc-error" data-testid="chat-error" role="alert">{error}</p>}
          {sent && !error && <p className="hc-note" role="status">{t('composer.sent')}</p>}
          <p className="hc-note">{operator ? t('composer.asOperator') : t('composer.privacy')}</p>
        </form>
      ) : (
        <div className="hc-composer">
          <p className="hc-note">{t('composer.privacy')}</p>
        </div>
      )}

      {reporting && <ReportDialog messageId={reporting} signedIn={signedIn} locale={locale} onClose={() => setReporting(null)} />}
    </>
  );
}
