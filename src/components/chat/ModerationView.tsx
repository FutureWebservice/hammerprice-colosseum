'use client';

/**
 * The room operator's panel: EVERY message of this room (waiting, public, rejected, reported), with the author's wallet, and the tools to decide:
 * approve (one, several, all waiting), reject with a reason the author sees, mute for a while, block for the show, lift. Only the operator
 * reaches this (the queue route answers not_seller to anyone else), and every action is written to the audit log by the server.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChatError, errorKey, moderate, type ModerateBody, type Queue, type QueueFilter } from './chatClient';

type QMessage = Queue['messages'][number];
type Form = { kind: 'reject'; ids: string[] } | { kind: 'mute'; paddle: number } | { kind: 'block'; paddle: number } | null;

const FILTERS: QueueFilter[] = ['pending', 'reported', 'approved', 'rejected', 'all'];
const PRESETS = ['offtopic', 'advert', 'rude', 'personal', 'other'] as const;

export const shortWallet = (w: string): string => `${w.slice(0, 4)}...${w.slice(-4)}`;

export default function ModerationView({ showId, queue, filter, onFilter, onChanged, locale, focusId = null }: {
  showId: string; queue: Queue | null; filter: QueueFilter; onFilter: (f: QueueFilter) => void; onChanged: () => void; locale: string;
  /** A message to scroll to and highlight (the deep link from the operator popup). */
  focusId?: string | null;
}) {
  const t = useTranslations('chat');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<Form>(null);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>('offtopic');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messages = useMemo(() => queue?.messages ?? [], [queue]);
  const live = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);
  const chosen = [...picked].filter((id) => live.has(id));
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }), [locale]);

  // Deep link: once the row is in the list, scroll it into view (no animation when the viewer asked for less motion) and move keyboard focus to it.
  const found = focusId != null && messages.some((m) => m.id === focusId);
  useEffect(() => {
    if (!focusId || !found) return;
    const el = document.getElementById(`hc-q-${focusId}`);
    if (!el) return;
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }, [focusId, found]);

  const run = async (body: ModerateBody) => {
    setBusy(true);
    setError(null);
    try {
      await moderate(showId, body);
      setPicked(new Set());
      setForm(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ChatError ? t(`error.${errorKey(e)}`) : t('mod.failed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pendingIds = messages.filter((m) => m.status === 'pending').map((m) => m.id);
  const reasonText = (): string => t(`mod.reasons.${preset}`);

  const count = (f: QueueFilter): number | null => (queue && f !== 'all' ? queue.counts[f] : null);

  return (
    <div className="hc-mod" data-testid="mod-view">
      <p className="hc-mod-intro">{t('mod.intro')}</p>
      <div className="hc-filters" role="tablist" aria-label={t('mod.title')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`hc-filter${filter === f ? ' is-on' : ''}`} onClick={() => { onFilter(f); setPicked(new Set()); }}>
            {t(`mod.filter.${f}`)}{count(f) != null ? <span className="hc-count">{count(f)}</span> : null}
          </button>
        ))}
      </div>

      <div className="hc-bulk">
        <button type="button" className="hc-btn" disabled={busy || messages.length === 0} onClick={() => setPicked(picked.size === messages.length ? new Set() : new Set(messages.map((m) => m.id)))}>{t('mod.selectAll')}</button>
        {chosen.length > 0 && (
          <>
            <span className="hc-bulk-n">{t('mod.selected', { count: chosen.length })}</span>
            <button type="button" data-testid="mod-approve-selected" className="hc-btn is-primary" disabled={busy} onClick={() => void run({ action: 'approve', messageIds: chosen })}>{t('mod.approveSelected')}</button>
            <button type="button" className="hc-btn" disabled={busy} onClick={() => setForm({ kind: 'reject', ids: chosen })}>{t('mod.rejectSelected')}</button>
          </>
        )}
        {chosen.length === 0 && filter === 'pending' && pendingIds.length > 1 && (
          <button type="button" data-testid="mod-approve-all" className="hc-btn is-primary" disabled={busy} onClick={() => void run({ action: 'approve', messageIds: pendingIds })}>{t('mod.approveAll')}</button>
        )}
      </div>

      {form && (
        <form className="hc-form" onSubmit={(e) => {
          e.preventDefault();
          if (form.kind === 'reject') void run({ action: 'reject', messageIds: form.ids, reason: reasonText() });
          else if (form.kind === 'mute') void run({ action: 'mute', paddle: form.paddle, minutes, reason: reasonText() });
          else void run({ action: 'block', paddle: form.paddle, reason: reasonText() });
        }}>
          <strong>{form.kind === 'reject' ? t('mod.rejectTitle', { count: form.ids.length }) : form.kind === 'mute' ? t('mod.muteTitle', { number: form.paddle }) : t('mod.blockTitle', { number: form.paddle })}</strong>
          {form.kind === 'block' && <span className="hc-note">{t('mod.blockText')}</span>}
          {form.kind === 'mute' && (
            <label className="hc-field">{t('mod.muteLength')}
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                <option value={10}>{t('mod.min10')}</option>
                <option value={60}>{t('mod.min60')}</option>
                <option value={1440}>{t('mod.min1440')}</option>
              </select>
            </label>
          )}
          <label className="hc-field">{form.kind === 'reject' ? t('mod.rejectWhy') : t('mod.muteWhy')}
            <select value={preset} onChange={(e) => setPreset(e.target.value as (typeof PRESETS)[number])}>
              {PRESETS.map((p) => <option key={p} value={p}>{t(`mod.reasons.${p}`)}</option>)}
            </select>
          </label>
          <div className="hc-form-actions">
            <button type="button" className="hc-btn" onClick={() => setForm(null)}>{t('mod.cancel')}</button>
            <button type="submit" data-testid="mod-confirm" className="hc-btn is-primary" disabled={busy}>{form.kind === 'reject' ? t('mod.rejectConfirm') : form.kind === 'mute' ? t('mod.mute') : t('mod.block')}</button>
          </div>
        </form>
      )}
      {error && <p className="hc-error" role="alert">{error}</p>}

      {queue && messages.length === 0 && <p className="hc-empty">{t('mod.empty')}</p>}
      <ul className="hc-qlist">
        {messages.map((m) => <Row key={m.id} m={m} focus={m.id === focusId} t={t} time={time} picked={picked.has(m.id)} busy={busy} onPick={() => toggle(m.id)}
          onApprove={() => void run({ action: 'approve', messageIds: [m.id] })} onReject={() => setForm({ kind: 'reject', ids: [m.id] })}
          onMute={() => m.paddle != null && setForm({ kind: 'mute', paddle: m.paddle })} onBlock={() => m.paddle != null && setForm({ kind: 'block', paddle: m.paddle })} />)}
      </ul>

      {queue && queue.silenced.length > 0 && (
        <div className="hc-silenced">
          <h3 className="hc-sub">{t('mod.silenced')}</h3>
          <ul className="hc-qlist">
            {queue.silenced.map((s) => (
              <li key={s.wallet} className="hc-qrow">
                <span>{s.paddle != null ? t('panel.bidder', { number: s.paddle }) : shortWallet(s.wallet)}{' '}
                  <span className="hc-note">{s.kind === 'block' ? t('mod.silencedBlock') : t('mod.silencedMute', { until: s.until ? time.format(new Date(s.until)) : '' })}</span></span>
                {s.paddle != null && <button type="button" className="hc-btn" disabled={busy} onClick={() => void run({ action: 'unsilence', paddle: s.paddle! })}>{t('mod.lift')}</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ m, focus, t, time, picked, busy, onPick, onApprove, onReject, onMute, onBlock }: {
  m: QMessage; focus: boolean; t: ReturnType<typeof useTranslations>; time: Intl.DateTimeFormat; picked: boolean; busy: boolean;
  onPick: () => void; onApprove: () => void; onReject: () => void; onMute: () => void; onBlock: () => void;
}) {
  const base = m.role === 'bidder' ? t('panel.bidder', { number: m.paddle ?? 0 }) : m.role === 'house' ? t('panel.house') : t('panel.seller');
  const who = m.name ? t('panel.named', { name: m.name, label: base }) : base;
  const label = m.status === 'pending' ? t('mod.statusPending') : m.status === 'approved' ? t('mod.statusApproved') : t('mod.statusRejected');
  return (
    <li id={`hc-q-${m.id}`} tabIndex={-1} data-testid="mod-row" data-status={m.status} data-focus={focus ? 'true' : undefined} aria-current={focus ? 'true' : undefined} className={`hc-qrow is-${m.status}${focus ? ' is-focus' : ''}`}>
      <label className="hc-pick">
        <input type="checkbox" data-testid="mod-pick" checked={picked} onChange={onPick} aria-label={t('mod.select')} />
      </label>
      <div className="hc-qbody">
        <div className="hc-qmeta">
          <b>{who}</b>
          <span title={m.wallet} className="hc-wallet">{t('mod.wallet')} {shortWallet(m.wallet)}</span>
          {m.lotNumber != null && <span>{t('panel.lotLabel', { number: m.lotNumber })}</span>}
          <span>{time.format(new Date(m.at))}</span>
          <span className={`hc-status is-${m.status}`}>{label}</span>
          {m.source === 'assistant' && <span className="hc-ai">{t('mod.assistantTag')}</span>}
          {m.reports > 0 && <span className="hc-reports">{m.reports === 1 ? t('mod.reportsOne') : t('mod.reports', { count: m.reports })}</span>}
        </div>
        <p className="hc-text">{m.body}</p>
        {m.reportDetails.map((d, i) => <p key={i} className="hc-note">{t(`report.reasons.${d.reason}`)}{d.detail ? `: ${d.detail}` : ''}</p>)}
        {m.status === 'rejected' && m.reason && <p className="hc-note">{m.reason}</p>}
        <div className="hc-qactions">
          {m.status !== 'approved' && <button type="button" data-testid="mod-approve" className="hc-btn is-primary" disabled={busy} onClick={onApprove}>{t('mod.approve')}</button>}
          {m.status !== 'rejected' && <button type="button" data-testid="mod-reject" className="hc-btn" disabled={busy} onClick={onReject}>{t('mod.reject')}</button>}
          {m.role === 'bidder' && m.paddle != null && (
            <>
              <button type="button" data-testid="mod-mute" className="hc-btn" disabled={busy} onClick={onMute}>{t('mod.mute')}</button>
              <button type="button" data-testid="mod-block" className="hc-btn" disabled={busy} onClick={onBlock}>{t('mod.block')}</button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
