'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import { NO_PAUSE, type ShowCore, type ShowPause } from '@/contracts/api';
import type { ShowStatus } from '@/contracts/common';
import { cancelShow, checkLotReadiness, controlLot, endShow, goLive, patchLot, pauseShow, resumeShow, type ApiFail } from './api';
import ConfirmButton from './ConfirmButton';
import BroadcastLink from './slots/BroadcastLink';
import SignInGate from './SignInGate';
import { formatWhen } from './datetime';
import { baseToInput, formatUsdc, parseUsdc } from './money';
import {
  EXTEND_SECONDS, canCancel, canEditReserve, canEnd, canExtend, canStart, canWithdraw, mergeLots, needsReadiness, pauseGate, type LotRow, type PauseGate,
} from './manageRules';
import { PAUSE_MAX_MS, PAUSE_MIN_LEFT_MS } from '@/lib/auction/rules';
import { formatDurationLong } from '@/lib/auction/time-format';
import { useApiError, useReasonText } from './useApiError';
import { useShowManage } from './useShowManage';
import './sell.css';

export type Note = { kind: 'ok' | 'error'; text: string };

export interface ManageHandlers {
  onStart: () => void;
  onEnd: () => void;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onWithdraw: (lot: LotRow) => void;
  onExtend: (lot: LotRow) => void;
  onSaveReserve: (lot: LotRow, value: string) => void;
  onRecheck: (lot: LotRow) => void;
}

function StatusPill({ status, paused = false }: { status: ShowStatus; paused?: boolean }) {
  const t = useTranslations('sell');
  return <span className={`sl-pill sl-pill--${status}`} data-testid="show-status" data-status={status} data-paused={paused ? 'true' : undefined}>{paused ? t('manage.pausedPill') : t(`manage.status.${status}`)}</span>;
}

export interface PauseUi { gate: PauseGate; state: ShowPause }

/** The pause controls of a live show (the seller's "Rostrum"): the button, the state while paused, and why it is unavailable when it is. */
function PauseNote({ ui }: { ui: PauseUi }) {
  const t = useTranslations('sell');
  const locale = useLocale();
  if (ui.gate === 'unavailable') return null;
  return (
    <div className="sl-note" data-testid="pause-note" data-gate={ui.gate}>
      {ui.gate === 'paused' && ui.state.resumesBy && <p role="status">{t('manage.pause.state', { when: formatWhen(ui.state.resumesBy, locale) })}</p>}
      {ui.gate !== 'paused' && <p>{t('manage.pause.hint', { max: ui.state.max, minutes: PAUSE_MAX_MS / 60_000, seconds: PAUSE_MIN_LEFT_MS / 1000 })}</p>}
      <p>
        {t('manage.pause.used', { used: ui.state.used, max: ui.state.max })}
        {ui.gate === 'limit' && <> {t('manage.pause.limit')}</>}
        {ui.gate === 'no_lot' && <> {t('manage.pause.noLot')}</>}
        {ui.gate === 'late' && <> {t('manage.pause.late')}</>}
      </p>
    </div>
  );
}

function LotCard({ lot, locale, note, busy, h }: { lot: LotRow; locale: string; note?: Note; busy: boolean; h: ManageHandlers }) {
  const t = useTranslations('sell');
  const [reserve, setReserve] = useState(lot.reserve ? baseToInput(lot.reserve) : '');
  const hasBids = lot.bidCount > 0;
  return (
    <li className="sl-lot" data-testid="manage-lot" data-lot={lot.id} data-state={lot.state}>
      <div className="sl-lot-head">
        {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
        {lot.imageUrl ? <img className="sl-lot-img" src={lot.imageUrl} alt="" loading="lazy" decoding="async" /> : <div className="sl-lot-img sl-card-img--empty" aria-hidden="true" />}
        <div>
          <p className="sl-lot-no">{t('wizard.terms.lotNo', { number: lot.lotNumber })}</p>
          <h3 className="sl-card-name">{lot.name}</h3>
          <p className="sl-card-meta">
            {lot.grade && <span className="sl-tag">{lot.grade}</span>}
            <span className="sl-tag sl-tag--dim" data-testid="lot-state">{t(`manage.lotState.${lot.state}`)}</span>
            <span className={`sl-badge sl-badge--${lot.consignStatus === 'ready' ? 'ready' : 'unchecked'}`} data-testid="consign-badge" data-state={lot.consignStatus}>
              {t(`manage.consign.${lot.consignStatus}`)}
            </span>
          </p>
        </div>
      </div>

      <dl className="sl-facts">
        <div><dt>{t('manage.bids')}</dt><dd data-testid="bid-count">{lot.bidCount}</dd></div>
        <div><dt>{t('manage.highBid')}</dt><dd>{lot.highBid ? formatUsdc(lot.highBid, locale) : t('manage.noBid')}</dd></div>
        <div><dt>{t('manage.opening')}</dt><dd>{formatUsdc(lot.openingPrice, locale)}</dd></div>
        <div><dt>{t('manage.reserve')}</dt><dd>{lot.reserve && lot.reserve !== '0' ? formatUsdc(lot.reserve, locale) : t('manage.noReserve')}</dd></div>
      </dl>

      {canEditReserve(lot) && (
        <div className="sl-inline">
          <label className="sl-field sl-field--inline">
            <span>{t('manage.editReserve')}</span>
            <input type="text" inputMode="decimal" value={reserve} data-testid="manage-reserve-input" onChange={(e) => setReserve(e.target.value)} />
          </label>
          <button type="button" className="sl-btn" data-testid="save-reserve" disabled={busy} onClick={() => h.onSaveReserve(lot, reserve)}>{t('manage.saveReserve')}</button>
        </div>
      )}

      <div className="sl-actions">
        {needsReadiness(lot) && <button type="button" className="sl-btn" data-testid="recheck-lot" disabled={busy} onClick={() => h.onRecheck(lot)}>{t('manage.recheck')}</button>}
        {canExtend(lot) && <button type="button" className="sl-btn" data-testid="extend-lot" disabled={busy} onClick={() => h.onExtend(lot)}>{t('manage.extend', { seconds: EXTEND_SECONDS })}</button>}
        {(lot.state === 'catalogued' || lot.state === 'open') && (
          <ConfirmButton label={t('manage.withdraw')} testId="withdraw-lot" disabled={busy || !canWithdraw(lot)} onConfirm={() => h.onWithdraw(lot)} />
        )}
      </div>
      {hasBids && (lot.state === 'catalogued' || lot.state === 'open') && <p className="sl-note" data-testid="withdraw-locked">{t('manage.withdrawLocked')}</p>}
      {note && <p className={note.kind === 'error' ? 'sl-warn' : 'sl-ok'} role={note.kind === 'error' ? 'alert' : 'status'} data-testid="lot-note" data-kind={note.kind}>{note.text}</p>}
    </li>
  );
}

/** The page body for loaded data. Pure apart from the small reserve-edit input state, so states are testable without a network. */
export function ManageView({
  show, status, lots, notes, busy, h, pause,
}: { show: ShowCore; status: ShowStatus; lots: LotRow[]; notes: Record<string, Note>; busy: boolean; h: ManageHandlers; pause?: PauseUi }) {
  const t = useTranslations('sell');
  const locale = useLocale();
  return (
    <>
      <div className="sl-toolbar">
        <div>
          <h2 className="sl-h2" data-testid="show-title">{show.title}</h2>
          <p className="sl-note">
            <StatusPill status={status} paused={pause?.gate === 'paused'} />{' '}
            {show.scheduledAt ? t('manage.scheduledFor', { when: formatWhen(show.scheduledAt, locale) }) : t('manage.noStart')}
          </p>
        </div>
        <div className="sl-actions">
          <Link href={`/room/${show.id}`} className="sl-btn" data-testid="open-room">{t('manage.openRoom')}</Link>
          <BroadcastLink showId={show.id} videoEnabled={show.video?.enabled === true} status={status} />
          {canStart(status) && <ConfirmButton label={t('manage.startNow')} testId="start-show" danger={false} disabled={busy} onConfirm={h.onStart} />}
          {pause?.gate === 'ok' && <ConfirmButton label={t('manage.pause.button')} testId="pause-show" danger={false} disabled={busy} onConfirm={h.onPause} />}
          {pause?.gate === 'paused' && <button type="button" className="sl-btn sl-btn--primary" data-testid="resume-show" disabled={busy} onClick={h.onResume}>{t('manage.pause.resume')}</button>}
          {canEnd(status) && <ConfirmButton label={t('manage.endShow')} testId="end-show" disabled={busy} onConfirm={h.onEnd} />}
          {canCancel(status) && <ConfirmButton label={t('manage.cancelShow')} testId="cancel-show" disabled={busy} onConfirm={h.onCancel} />}
        </div>
      </div>
      {notes.show && <p className={notes.show.kind === 'error' ? 'sl-warn' : 'sl-ok'} role={notes.show.kind === 'error' ? 'alert' : 'status'} data-testid="show-note" data-kind={notes.show.kind}>{notes.show.text}</p>}
      {show.kind !== 'timed' && <p className="sl-note" data-testid="manage-duration">{t('manage.lotDuration', { duration: formatDurationLong(show.lotDurationS ?? 45, locale) })}</p>}
      {pause && <PauseNote ui={pause} />}
      <p className="sl-note" data-testid="manage-rules">{t('manage.rules')}</p>
      <ul className="sl-lots">
        {lots.map((l) => <LotCard key={l.id} lot={l} locale={locale} note={notes[l.id]} busy={busy} h={h} />)}
      </ul>
    </>
  );
}

function Inner({ showId }: { showId: string }) {
  const t = useTranslations('sell');
  const errorText = useApiError();
  const reasonText = useReasonText();
  const { data, reloadDetail, reloadSnapshot, applySnapshot } = useShowManage(showId);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [busy, setBusy] = useState(false);

  const say = (key: string, n: Note | null) => setNotes((x) => {
    const rest = { ...x };
    delete rest[key];
    return n ? { ...rest, [key]: n } : rest;
  });
  const fail = (key: string, e: ApiFail) => say(key, { kind: 'error', text: errorText(e) + (e.reason && e.code === 'wrong_state' ? ` ${e.reason}` : '') });

  async function run(key: string, job: () => Promise<{ ok: true } | ApiFail>, okText: string) {
    setBusy(true);
    say(key, null);
    const r = await job();
    setBusy(false);
    if (r.ok) say(key, { kind: 'ok', text: okText });
    else fail(key, r);
  }

  /** Re-read one card's readiness (no wallet prompt), then show what the server found. */
  async function recheck(lot: LotRow) {
    setBusy(true);
    say(lot.id, null);
    const r = await checkLotReadiness(lot.id);
    setBusy(false);
    if (!r.ok) return fail(lot.id, r);
    await reloadDetail();
    say(lot.id, r.data.readiness.eligible
      ? { kind: 'ok', text: t('manage.ready') }
      : { kind: 'error', text: r.data.readiness.reasons.map((x) => reasonText(x)).join(' ') });
  }

  if (data.status === 'loading') return <p className="sl-note" role="status" data-testid="manage-loading">{t('manage.loading')}</p>;
  if (data.status === 'error') return <p className="sl-warn" role="alert" data-testid="manage-error">{data.error.code === 'not_found' ? t('manage.notFound') : errorText(data.error)}</p>;

  const { detail, snapshot } = data;
  const status = snapshot?.show.status ?? detail.show.status;
  const h: ManageHandlers = {
    onStart: () => void run('show', async () => { const r = await goLive(showId); if (r.ok) await reloadDetail(); return r; }, t('manage.started')),
    onEnd: () => void run('show', async () => { const r = await endShow(showId); if (r.ok) await reloadDetail(); return r; }, t('manage.ended')),
    onCancel: () => void run('show', async () => { const r = await cancelShow(showId); if (r.ok) await reloadDetail(); return r; }, t('manage.cancelled')),
    onPause: () => void run('show', async () => { const r = await pauseShow(showId); if (r.ok) await reloadSnapshot(); return r; }, t('manage.paused')),
    onResume: () => void run('show', async () => { const r = await resumeShow(showId); if (r.ok) await reloadSnapshot(); return r; }, t('manage.resumed')),
    onWithdraw: (lot) => void run(lot.id, async () => { const r = await controlLot(lot.id, { action: 'withdraw' }); if (r.ok) applySnapshot(r.data.live); return r; }, t('manage.withdrawn')),
    onExtend: (lot) => void run(lot.id, async () => { const r = await controlLot(lot.id, { action: 'extend', seconds: EXTEND_SECONDS }); if (r.ok) applySnapshot(r.data.live); return r; }, t('manage.extended', { seconds: EXTEND_SECONDS })),
    onRecheck: (lot) => void recheck(lot),
    onSaveReserve: (lot, value) => {
      const p = parseUsdc(value);
      if (!p.ok) return say(lot.id, { kind: 'error', text: t(`wizard.terms.issues.amount_${p.issue}`) });
      if (BigInt(p.base) < BigInt(lot.openingPrice)) return say(lot.id, { kind: 'error', text: t('wizard.terms.issues.reserve_below_opening') });
      void run(lot.id, async () => { const r = await patchLot(lot.id, { reserve: p.base }); if (r.ok) await reloadDetail(); return r; }, t('manage.reserveSaved'));
    },
  };
  const lots = mergeLots(detail.lots, snapshot);
  const pauseState = snapshot?.show.pause ?? NO_PAUSE;
  const pause: PauseUi | undefined = snapshot
    ? {
        state: pauseState,
        gate: pauseGate({ status, kind: detail.show.kind ?? 'live', pause: pauseState, openLotClosesAt: lots.find((l) => l.state === 'open')?.closesAt ?? null, serverNowMs: snapshot.serverNow }),
      }
    : undefined;
  return <ManageView show={detail.show} status={status} lots={lots} notes={notes} busy={busy} h={h} pause={pause} />;
}

export default function Manage({ showId }: { showId: string }) {
  const t = useTranslations('sell');
  return (
    <div className="hp sl">
      <header className="sl-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="sl-h1">{t('manage.title')}</h1>
        <p className="sl-note"><Link href="/sell">{t('wizard.backToSell')}</Link></p>
      </header>
      <SignInGate>
        <Inner showId={showId} />
      </SignInGate>
    </div>
  );
}
