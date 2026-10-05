'use client';

import Logo from '@/components/brand/Logo';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useSession } from '@/components/auth/SessionProvider';
import { AiCallError, errorKey, postAgent } from './client';
import { CardView } from './AgentCards';
import ConnectGate from './ConnectGate';
import { loadHistory, saveHistory, type Msg } from './history';
import { chatLine } from './chatLine';
import { clock, usdc } from './live';
import { useRoomContext } from './roomContext';
import { ADVICE_RE } from '@/server/ai/keyword';
import './ai.css';
import './agent.css';

export { CardView };
/** The lot on the block in the room that opened the assistant. It is DATA for the agent (a lot id and a name between tags on the server), never an instruction. */
export interface RoomLot { lotId: string; name: string; lotNumber: number }
/** The question the answer at index `i` belongs to (advice answers are never offered for the chat). */
const prevUser = (msgs: readonly Msg[], i: number): string => { const m = msgs[i - 1]; return m && m.role === 'user' ? m.text : ''; };
const EXAMPLES = ['example1', 'example2', 'example3'] as const;
const ROOM_EXAMPLES = ['roomExample1', 'roomExample2', 'roomExample3'] as const;

const Avatar = () => (
  <span className="agc-avatar" aria-hidden="true">
    <Logo variant="symbol" className="agc-avatar-mark" />
  </span>
);

/**
 * The chat agent: the full page at /ai (`variant="page"`) and the assistant drawer in the rooms (`variant="drawer"`, the same component and the same
 * POST /api/ai/agent). Every AI function needs a signed-in wallet: without one the visitor sees the chat with a "connect your wallet" card in place of
 * the composer, and nothing is sent. The answer is a sentence composed by the server plus cards. Nothing here acts on its own: a lot card links to the
 * room, a bid card only links to the room (the bid is placed there with the user's own wallet, in the normal flow), a draft card calls the listing route
 * only when the user presses its button.
 *
 * The conversation (messages and the cards needed to draw them again) is kept in this browser only, per signed-in wallet (history.ts): it is restored
 * on the next visit, shared between the page and the room drawer, and removed only by "Reset chat" (one confirming click). It is never sent to the server.
 */
export default function AgentChat({ locale, variant = 'page', roomLot = null, showId, active = true, onClose }: {
  locale: string; variant?: 'page' | 'drawer'; roomLot?: RoomLot | null;
  /** The room (drawer only): the status chips and the operator's "Publish in the room chat" belong to it. */
  showId?: string;
  /** The drawer stays mounted while closed (an answer on its way is not lost); `active` says it is open, so the cursor goes to the composer. */
  active?: boolean; onClose?: () => void;
}) {
  const t = useTranslations('ai');
  const lang: 'de' | 'en' = locale.startsWith('de') ? 'de' : 'en';
  const { status, me, refresh } = useSession();
  const signedIn = status === 'signed-in';
  const wallet = signedIn ? me?.wallet ?? null : null;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null); // the wallet whose history is in `msgs`
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const id = useId();
  const Title = variant === 'page' ? 'h1' : 'h2';
  const room = useRoomContext(showId, active, signedIn);
  const [pub, setPub] = useState<Record<number, 'busy' | 'done' | 'failed' | 'refused'>>({});
  const nonces = useRef<Record<number, string>>({});

  // The history of this wallet comes in when the wallet is known and goes away (from view, not from the browser) when it signs out or changes.
  useEffect(() => { setMsgs(wallet ? loadHistory(wallet) : []); setLoaded(wallet); setErr(null); setConfirming(false); }, [wallet]);
  useEffect(() => { if (wallet && loaded === wallet) saveHistory(wallet, msgs); }, [msgs, wallet, loaded]);

  // The composer grows with the text (up to 200 px, then it scrolls).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [q, signedIn]);
  // New messages and the typing indicator scroll into view (a plain jump: no animation to turn off for reduced motion). A new answer is read from its
  // top, so a tall one (cards) does not hide its first sentence.
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const answers = el.querySelectorAll<HTMLElement>('[data-testid="ai-agent-answer"]');
    const lastAnswer = answers[answers.length - 1];
    el.scrollTop = msgs.length === 0 ? 0 : !busy && msgs[msgs.length - 1]?.role === 'ai' && lastAnswer ? Math.max(0, lastAnswer.offsetTop - 12) : el.scrollHeight;
  }, [msgs, busy]);
  // After a sign-in the person started here, the cursor is in the composer. A drawer that was just opened puts it there (or on the connect button).
  useEffect(() => { if (signedIn && wantFocus.current) { wantFocus.current = false; input.current?.focus(); } }, [signedIn]);
  useEffect(() => {
    if (variant === 'drawer' && active) (input.current ?? root.current?.querySelector<HTMLElement>('[data-testid="ai-gate-connect"]'))?.focus();
  }, [variant, active, signedIn]);
  // The reset asks once: a second click within a few seconds does it, anything else cancels.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !signedIn) return;
    const last = [...msgs].reverse().find((m) => m.role === 'ai' && m.cards.some((c) => c.type === 'lots'));
    const found = last && last.role === 'ai' ? last.cards.flatMap((c) => (c.type === 'lots' ? c.lots : [])) : [];
    // The lot on the block comes first: "this lot" means it. Everything is data on the server (tagged, never an instruction).
    const lots = [
      ...(roomLot ? [{ lotId: roomLot.lotId, name: roomLot.name, lotNumber: roomLot.lotNumber }] : []),
      ...found.filter((l) => l.lotId !== roomLot?.lotId),
    ].slice(0, 8);
    setConfirming(false); setBusy(true); setErr(null); setQ('');
    setMsgs((m) => [...m, { role: 'user', text: message }]);
    try {
      const r = await postAgent({ message, locale: lang, ...(lots.length ? { lastResults: lots.map((l) => ({ lotId: l.lotId, name: l.name.slice(0, 120), lotNumber: l.lotNumber })) } : {}) });
      setMsgs((m) => [...m, { role: 'ai', ...r }]);
    } catch (e) {
      setQ((cur) => cur || message); // the text is not lost
      if (e instanceof AiCallError && (e.code === 'unauthenticated' || e.code === 'banned')) { setErr('agent.signIn'); void refresh(); } // the session ended: the gate comes back
      else setErr(errorKey(e, 'agent'));
    } finally { setBusy(false); input.current?.focus(); }
  }

  /** The operator puts an answer into the moderated chat (labelled AI there). The chat's own rules apply: an answer with a link is refused. */
  async function publish(i: number, text: string) {
    if (!showId) return;
    setPub((p) => ({ ...p, [i]: 'busy' }));
    nonces.current[i] ??= crypto.randomUUID(); // a second click is the same message, not a second one
    const r = await fetch(`/api/shows/${encodeURIComponent(showId)}/chat/moderate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ action: 'publish', body: chatLine(text), source: 'assistant', clientNonce: nonces.current[i] }),
    }).catch(() => null);
    setPub((p) => ({ ...p, [i]: r?.ok ? 'done' : r?.status === 400 ? 'refused' : 'failed' }));
  }

  function reset() {
    if (!confirming) { setConfirming(true); return; }
    setConfirming(false); setMsgs([]); setErr(null); setQ(''); setPub({}); nonces.current = {};
    input.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(q); }
  }

  function prepareBid(l: { lotNumber: number; name: string }) {
    const mark = '\u0000';
    const text = t('agent.prepareBidText', { amount: mark, name: l.name.slice(0, 60), n: l.lotNumber });
    const at = text.indexOf(mark);
    setQ(text.replace(mark, ''));
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(at, at); } });
  }

  const examples = roomLot ? ROOM_EXAMPLES : EXAMPLES;
  const hist = loaded !== wallet; // the stored conversation of this wallet is still being read: show neither the welcome nor old messages
  return (
    <section ref={root} className={`agc agc--${variant}`} aria-label={t('agent.title')} data-testid="ai-agent" data-session={status}>
      <header className="agc-bar">
        <div className="agc-in agc-bar-in">
          <Avatar />
          <Title className="agc-title">{t('agent.title')}</Title>
          {roomLot && <span className="agc-ctx" data-testid="ai-agent-room">{t('agent.roomContext', { n: roomLot.lotNumber })}</span>}
          <span className="agc-sp" />
          {msgs.length > 0 && (
            <button type="button" className={`agc-reset${confirming ? ' is-confirm' : ''}`} onClick={reset} onBlur={() => setConfirming(false)} data-testid="ai-agent-new" aria-live="polite">
              {confirming ? t('agent.resetConfirm') : t('agent.reset')}
            </button>
          )}
          {onClose && <button type="button" className="agc-close" onClick={onClose} aria-label={t('agent.close')} data-testid="ai-agent-close">×</button>}
        </div>
      </header>

      {showId && room.facts && (
        <div className="agc-status" role="group" aria-label={t('ask.liveHeading')} data-testid="ai-live">
          {room.facts.lotNumber === null ? <span className="agc-chip">{t('ask.liveNone')}</span> : (
            <>
              <span className="agc-chip">{t('ask.liveLot', { n: room.facts.lotNumber })}</span>
              <span className="agc-chip">{room.facts.highBidUsdc ? t('ask.liveBid', { amount: usdc(room.facts.highBidUsdc) }) : t('ask.liveNoBid')}</span>
              {room.msLeft !== null && <span className="agc-chip" role="timer">{t('ask.liveTime', { time: clock(room.msLeft) })}</span>}
            </>
          )}
        </div>
      )}

      <div className="agc-log" ref={log} role="log" aria-live="polite" aria-relevant="additions" aria-label={t('agent.log')} tabIndex={0} data-testid="ai-agent-log">
        <div className="agc-in agc-col">
          {msgs.length === 0 && !hist && (
            <div className="agc-hero">
              <span className="agc-hero-mark" aria-hidden="true"><Avatar /></span>
              <div className="agc-hero-text" data-testid="ai-agent-intro">{t('agent.intro')}</div>
              <div className="agc-examples" role="group" aria-label={t('agent.examples')} data-testid="ai-agent-examples">
                {examples.map((k) => (
                  <button key={k} type="button" className="agc-ex" disabled={busy || !signedIn} onClick={() => void send(t(`agent.${k}`))} data-testid={`ai-agent-${k.replace('roomE', 'e')}`}>
                    <span>{t(`agent.${k}`)}</span>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (m.role === 'user' ? (
            <div key={i} className="agc-turn agc-turn--you">
              <div className="agc-bubble--you" data-testid="ai-agent-user"><span className="ai-sr">{t('agent.you')}: </span>{m.text}</div>
            </div>
          ) : (
            <article key={i} className="agc-turn" data-testid="ai-agent-answer" data-label={m.label}>
              <Avatar />
              <div className="agc-stack">
                <span className={`ai-badge agc-label ${m.label === 'faq' ? 'ai-badge--template' : ''}`}>{m.label === 'ai' ? t('agent.labelAi') : t('agent.labelFaq')}</span>
                <div className="agc-bubble--ai">{m.text}</div>
                {m.cards.map((c, j) => <CardView key={j} card={c} lang={lang} onPrepareBid={prepareBid} />)}
                {room.operator && m.cards.length === 0 && !ADVICE_RE.test(prevUser(msgs, i)) && (
                  <div className="agc-publish" data-testid="ai-publish-row">
                    <span className="agc-note">{t('ask.publishNote')}</span>
                    <button type="button" className="agc-reset" onClick={() => void publish(i, m.text)} disabled={pub[i] === 'busy' || pub[i] === 'done'} data-testid="ai-publish">{pub[i] === 'busy' ? t('ask.publishing') : t('ask.publish')}</button>
                    {pub[i] === 'done' && <span role="status" className="agc-ok" data-testid="ai-published">{t('ask.published')}</span>}
                    {pub[i] === 'failed' && <span role="alert" className="ai-err">{t('ask.publishFailed')}</span>}
                    {pub[i] === 'refused' && <span role="alert" className="ai-err" data-testid="ai-publish-refused">{t('ask.publishRefused')}</span>}
                  </div>
                )}
              </div>
            </article>
          )))}
          {busy && (
            <div className="agc-turn" role="status" data-testid="ai-agent-typing">
              <Avatar />
              <div className="agc-typing"><span className="ai-sr">{t('agent.thinking')}</span><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></div>
            </div>
          )}
        </div>
      </div>

      <div className="agc-foot">
        <div className="agc-in">
          {err && <div className="ai-err" role="alert" data-testid="ai-agent-error">{t(err)}</div>}
          {signedIn ? (
            <form className="agc-composer" onSubmit={(e) => { e.preventDefault(); void send(q); }}>
              <label htmlFor={`${id}-q`} className="ai-sr">{t('agent.placeholder')}</label>
              <textarea id={`${id}-q`} ref={input} rows={1} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} maxLength={300} placeholder={t('agent.placeholder')} autoComplete="off" aria-describedby={`${id}-hint`} data-testid="ai-agent-input" />
              <button type="submit" className="agc-send" aria-label={t('agent.send')} disabled={busy || !q.trim()} data-testid="ai-agent-send">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
              </button>
            </form>
          ) : (
            <ConnectGate onStart={() => { wantFocus.current = true; }} />
          )}
          <div className="agc-hint" id={`${id}-hint`} data-testid="ai-agent-note">
            {t('agent.note')}{signedIn && <> <span className="agc-saved" data-testid="ai-agent-saved">{t('agent.saved')}</span></>}
          </div>
        </div>
      </div>
    </section>
  );
}
