'use client';

/**
 * The room operator's popup: a new message waits for approval. Bottom corner, non-blocking, dismissable. Shows the newest waiting message
 * (plain text, about 80 characters, the bidder number and never a wallet) and a count when several wait; Approve and Reject act on that one
 * message (Reject offers fixed reasons), "Open chat" opens the Moderation tab on it. The data is the operator-only queue route, polled about
 * every 5 s while the tab is visible (queue limit 4 per 5 s); for anyone else nothing is rendered and nothing is polled.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChatError, fetchQueue, pollDelayMs, type Queue } from './chatClient';
import { useLoop } from './useChat';
import { decide, pickToast, previewText, REJECT_PRESETS, type QMessage, type RejectPreset } from './toastLogic';

type T = ReturnType<typeof useTranslations>;

export interface ModToastViewProps {
  t: T;
  who: string;
  preview: string;
  count: number;
  step: 'idle' | 'reject';
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onRejectStart: () => void;
  onRejectWith: (p: RejectPreset) => void;
  onBack: () => void;
  onOpen: () => void;
  onDismiss: () => void;
}

/** Presentation only (no hooks, so a test can call it and read the buttons' handlers). */
export function ModToastView({ t, who, preview, count, step, busy, error, onApprove, onRejectStart, onRejectWith, onBack, onOpen, onDismiss }: ModToastViewProps) {
  return (
    <section className="hc-toast" data-testid="mod-toast" aria-label={t('toast.label')} onKeyDown={(e) => { if (e.key === 'Escape') onDismiss(); }}>
      <header className="hc-toast-head">
        <strong className="hc-toast-title" data-testid="mod-toast-title">{t('toast.title', { count })}</strong>
        <button type="button" data-testid="mod-toast-dismiss" className="hc-x hc-toast-x" onClick={onDismiss} aria-label={t('toast.dismiss')}>×</button>
      </header>
      {count > 1 && <p className="hc-note">{t('toast.newest')}</p>}
      <p className="hc-toast-msg"><b>{who}</b>: <span data-testid="mod-toast-preview">{preview}</span></p>
      {step === 'idle' ? (
        <div className="hc-toast-actions">
          <button type="button" data-testid="mod-toast-approve" className="hc-btn is-primary" disabled={busy} onClick={onApprove}>{t('mod.approve')}</button>
          <button type="button" data-testid="mod-toast-reject" className="hc-btn" disabled={busy} onClick={onRejectStart}>{t('mod.reject')}</button>
          <button type="button" data-testid="mod-toast-open" className="hc-btn" onClick={onOpen}>{t('toast.open')}</button>
        </div>
      ) : (
        <div role="group" aria-label={t('mod.rejectWhy')}>
          <p className="hc-note">{t('mod.rejectWhy')}</p>
          <div className="hc-toast-actions">
            {REJECT_PRESETS.map((p) => (
              <button key={p} type="button" data-testid={`mod-toast-reason-${p}`} className="hc-btn" disabled={busy} onClick={() => onRejectWith(p)}>{t(`mod.reasons.${p}`)}</button>
            ))}
            <button type="button" data-testid="mod-toast-back" className="hc-btn" onClick={onBack}>{t('toast.back')}</button>
          </div>
        </div>
      )}
      {error && <p className="hc-error" role="alert">{error}</p>}
    </section>
  );
}

export interface ModToastProps {
  showId: string;
  /** The caller is this room's operator (from the chat's `mine` answer, which the server decides). */
  operator: boolean;
  /** The chat feature is on. */
  enabled: boolean;
  /** The Moderation tab is on screen: it shows the same messages, so the popup stays away. */
  paused: boolean;
  onOpen: (messageId: string) => void;
  /** After a decision: refresh the chat's own lists and badge. */
  onChanged: () => void;
}

export default function ModToast({ showId, operator, enabled, paused, onOpen, onChanged }: ModToastProps) {
  const t = useTranslations('chat');
  const active = operator && enabled && !paused;
  const [queue, setQueue] = useState<Queue | null>(null);
  const [dismissed, setDismissed] = useState(0);
  const [step, setStep] = useState<'idle' | 'reject'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = useRef(0);

  const refresh = useLoop(async () => {
    try {
      const r = await fetchQueue(showId, 'pending');
      errors.current = 0;
      setQueue(r);
      return Math.round(5_000 * (0.9 + Math.random() * 0.2));
    } catch (e) {
      if (e instanceof ChatError && e.code === 'not_seller') return 60_000;
      errors.current++;
      return pollDelayMs({ open: false, enabled: true, errorStreak: errors.current, random: Math.random() });
    }
  }, active, [showId]);

  useEffect(() => { if (!active) setQueue(null); }, [active]);

  const { newest, count } = pickToast(queue, dismissed);
  const newestId = newest?.id;
  useEffect(() => { setStep('idle'); setError(null); }, [newestId]);

  if (!operator || !enabled) return null;

  const who = (m: QMessage): string => (m.paddle != null ? t('panel.bidder', { number: m.paddle }) : t('toast.someone'));
  const run = async (m: QMessage, d: Parameters<typeof decide>[1]) => {
    setBusy(true);
    setError(null);
    const r = await decide(showId, d, (p) => t(`mod.reasons.${p}`));
    setBusy(false);
    if (!r.ok) { setError(t(`error.${r.errorKey}`)); return; }
    // The decided message leaves the popup at once; the next poll confirms.
    setQueue((q) => (q ? { ...q, messages: q.messages.filter((x) => x.id !== m.id), counts: { ...q.counts, pending: Math.max(0, q.counts.pending - 1) } } : q));
    refresh();
    onChanged();
  };

  return (
    // The live region exists before its content does, so a screen reader announces the message when it arrives.
    <div className="hc-toast-wrap" role="status" aria-live="polite" aria-atomic="true">
      {active && newest && (
        <ModToastView
          t={t} who={who(newest)} preview={previewText(newest.body)} count={count} step={step} busy={busy} error={error}
          onApprove={() => void run(newest, { kind: 'approve', id: newest.id })}
          onRejectStart={() => setStep('reject')}
          onRejectWith={(preset) => void run(newest, { kind: 'reject', id: newest.id, preset })}
          onBack={() => setStep('idle')}
          onOpen={() => onOpen(newest.id)}
          onDismiss={() => setDismissed(Math.max(0, ...(queue?.messages ?? []).map((m) => m.seq)))}
        />
      )}
    </div>
  );
}
