'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { z } from 'zod';
import type { AiAskResponse } from '@/contracts';
import { useSession } from '@/components/auth/SessionProvider';
import { AiCallError, errorKey, postAsk } from './client';
import ConnectGate from './ConnectGate';
import './ai.css';

type Answer = z.infer<typeof AiAskResponse>;
const EXAMPLES = ['example1Sell', 'example2Sell', 'example3Sell'] as const;

/**
 * "Help with selling": a folded section of the sell wizard (price step). It needs a signed-in wallet (the route answers 401 otherwise): a visitor without
 * one sees the "connect your wallet" card in place of the question field, and nothing is sent. The answer is ALWAYS a fixed FAQ text the server picked
 * (marked "AI assistant" or "from the FAQ"), shown only to the asker, never stored, with no history. The assistant in the auction rooms is the agent
 * drawer (RoomAssistant.tsx, the same chat as /ai), not this panel.
 */
export default function AskPanel({ locale }: { locale: string }) {
  const t = useTranslations('ai');
  const { status, refresh } = useSession();
  const signedIn = status === 'signed-in';
  const lang: 'de' | 'en' = locale.startsWith('de') ? 'de' : 'en';
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asked, setAsked] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy || !signedIn) return;
    setBusy(true); setErr(null); setAnswer(null); setAsked(text);
    try {
      setAnswer(await postAsk(text, lang));
    } catch (e) {
      setErr(e instanceof AiCallError && e.code === 'feature_off' ? 'ask.failed' : errorKey(e, 'ask'));
      if (e instanceof AiCallError && (e.code === 'unauthenticated' || e.code === 'banned')) { setErr('agent.signIn'); void refresh(); } // the session ended: the gate comes back
    } finally { setBusy(false); }
  }

  return (
    <details className="ai-panel ai-panel--ask" data-testid="ai-ask-sell">
      <summary>{t('ask.buttonSell')}</summary>
      <div className="ai-body">
        <div className="ai-askbody" data-testid="ai-ask-body">
          <p className="ai-note">{t('ask.introSell')}</p>
          {!signedIn ? <ConnectGate /> : (
            <form className="ai-askform" onSubmit={(e) => { e.preventDefault(); void send(q); }}>
              <label htmlFor={`${id}-q`} className="ai-sr">{t('ask.placeholder')}</label>
              <input id={`${id}-q`} ref={input} value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder={t('ask.placeholder')} autoComplete="off" data-testid="ai-ask-input" />
              <button type="submit" className="ai-btn ai-btn--primary" disabled={busy || !q.trim()} data-testid="ai-ask-send">{busy ? t('ask.asking') : t('ask.send')}</button>
            </form>
          )}
          {signedIn && !answer && !busy && (
            <p className="ai-examples">{t('ask.examples')}:{' '}
              {EXAMPLES.map((k) => <button key={k} type="button" className="ai-chip" onClick={() => { setQ(t(`ask.${k}`)); void send(t(`ask.${k}`)); }}>{t(`ask.${k}`)}</button>)}
            </p>
          )}
          {err && <p className="ai-err" role="alert" data-testid="ai-ask-error">{t(err)}</p>}
          <div aria-live="polite">
            {answer && (
              <article className="ai-answer" data-testid="ai-answer" data-faq-key={answer.faqKey ?? ''} data-label={answer.label}>
                <p className={`ai-badge ${answer.label === 'faq' ? 'ai-badge--template' : ''}`} data-testid="ai-answer-badge">{answer.label === 'ai' ? t('badge.ai') : t('badge.faq')} · {t('ask.onlyYou')}</p>
                <p className="ai-q">{asked}</p>
                <p className="ai-a" data-testid="ai-answer-text">{answer.answer}</p>
                {answer.faqKey === null && (
                  <p className="ai-links"><a href={`/${lang}/faq`}>{t('ask.faqLink')}</a> · <a href={`/${lang}/legal/impressum`}>{t('ask.contactLink')}</a></p>
                )}
                {answer.faqKey === 'no_advice' && <p className="ai-note">{t('ask.noAdvice')}</p>}
                {answer.faqKey && answer.faqKey !== 'no_advice' && <p className="ai-note">{t('ask.wrongAnswer')}</p>}
              </article>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}
