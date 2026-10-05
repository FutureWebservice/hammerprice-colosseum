'use client';

/**
 * "Connect Telegram" on the account page (FEATURE_TELEGRAM). Opt-in: the user ticks what they want, presses Connect, opens the one-time deep link
 * in Telegram and taps Start; this page notices and shows the connected state, where the switches can be changed and the chat disconnected.
 * While the feature is off (or the bot is not configured) the status route answers `enabled: false` and the panel renders nothing at all.
 *
 * `TelegramView` is the pure part (props in, markup out); `TelegramPanel` holds the state and talks to the routes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { TelegramPrefs, TelegramType } from '@/contracts/telegram';
import { TELEGRAM_TYPES } from '@/contracts/telegram';
import { getTelegramStatus, startTelegramLink, unlinkTelegram, updateTelegramLink } from './api';
import { applyTelegramIntent, wantsTelegram, withoutIntent, TELEGRAM_ANCHOR } from './intent';
import './telegram.css';

type Status = { enabled: boolean; linked: boolean; locale: 'en' | 'de' | null; prefs: TelegramPrefs; botUsername: string };
export type Pending = { url: string; expiresAt: number } | null;
export type Note = 'saved' | 'error' | 'rateLimited' | 'expired' | null;

export interface ViewProps {
  status: Status;
  prefs: TelegramPrefs;
  pending: Pending;
  busy: boolean;
  note: Note;
  onToggle: (k: TelegramType, on: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function TelegramView({ status, prefs, pending, busy, note, onToggle, onConnect, onDisconnect }: ViewProps) {
  const t = useTranslations('telegram');
  return (
    <section className="tg" id={TELEGRAM_ANCHOR} aria-labelledby="tg-title" tabIndex={-1} data-testid="telegram-panel">
      <h2 className="sl-h3" id="tg-title">{t('ui.title')}</h2>
      <p className="sl-lede">{t('ui.lede')}</p>
      {status.linked && <p className="sl-ok" data-testid="telegram-connected">{t('ui.connected', { bot: status.botUsername })}</p>}
      <fieldset className="tg-fieldset" disabled={(busy && status.linked) || pending !== null}>
        <legend>{t('ui.choose')}</legend>
        <ul className="tg-types">
          {TELEGRAM_TYPES.map((k) => (
            <li key={k}>
              <label className="tg-type">
                <input type="checkbox" checked={prefs[k]} onChange={(e) => onToggle(k, e.target.checked)} data-testid={`telegram-type-${k}`} />
                <span><strong>{t(`ui.types.${k}.label`)}</strong><span className="sl-hint">{t(`ui.types.${k}.hint`)}</span></span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="sl-actions">
        {status.linked ? (
          <>
            <button type="button" className="sl-btn sl-btn--danger" onClick={onDisconnect} disabled={busy} data-testid="telegram-disconnect">{busy ? t('ui.disconnecting') : t('ui.disconnect')}</button>
            <span className="sl-note" style={{ margin: 0 }}>{t('ui.stopHint')}</span>
          </>
        ) : pending ? (
          <>
            <a className="sl-btn sl-btn--primary" href={pending.url} target="_blank" rel="noopener noreferrer" data-testid="telegram-open">{t('ui.open')}</a>
            <span className="sl-note" style={{ margin: 0 }}>{t('ui.waiting')}</span>
          </>
        ) : (
          <button type="button" className="sl-btn sl-btn--primary" onClick={onConnect} disabled={busy} data-testid="telegram-connect">{busy ? t('ui.preparing') : t('ui.connect')}</button>
        )}
      </div>
      <p aria-live="polite" className={note === 'saved' ? 'sl-ok' : 'sl-no'} data-testid="telegram-note">
        {note === 'saved' && t('ui.saved')}
        {note === 'error' && t('ui.error')}
        {note === 'rateLimited' && t('ui.rateLimited')}
        {note === 'expired' && t('ui.expired')}
      </p>
      <p className="sl-note">{t('ui.privacy')}</p>
    </section>
  );
}

const POLL_MS = 3000;

export default function TelegramPanel() {
  const locale = useLocale();
  const lang: 'en' | 'de' = locale === 'de' ? 'de' : 'en';
  const [status, setStatus] = useState<Status | null>(null); // null: loading, or the feature is off (nothing is rendered either way)
  const [prefs, setPrefs] = useState<TelegramPrefs | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    const r = await getTelegramStatus(signal);
    if (!alive.current || !r.ok || !r.data.enabled) return null; // the feature is off here, or the call failed: show nothing
    setStatus(r.data);
    setPrefs(r.data.prefs);
    return r.data;
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal).then((s) => { if (s?.linked && s.locale !== lang) void updateTelegramLink({ locale: lang }); }).catch(() => {});
    return () => ctl.abort();
  }, [load, lang]);

  // While a link is open, look every few seconds whether the user tapped Start; give up when the 10 minutes are over.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => {
      if (Date.now() >= pending.expiresAt) { setPending(null); setNote('expired'); return; }
      void load().then((s) => { if (s?.linked) { setPending(null); setNote(null); } });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pending, load]);

  // A link with ?telegram=open (or the old #telegram) lands here: scroll, focus the action, highlight. The panel only renders once the visitor is
  // signed in (the sign-in gate sits above it), so a visitor who had to sign in first arrives here right after, with the URL still carrying the intent.
  const ready = status !== null && prefs !== null;
  const linked = status?.linked ?? false;
  const handled = useRef(false);
  useEffect(() => {
    if (!ready || handled.current) return;
    const { pathname, search, hash } = window.location;
    if (!wantsTelegram(search, hash)) return;
    const root = document.getElementById(TELEGRAM_ANCHOR);
    if (!root) return;
    handled.current = true;
    const off = applyTelegramIntent(root, { linked, reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    history.replaceState(history.state, '', withoutIntent(pathname, search, hash)); // a reload must not replay it
    return off;
  }, [ready, linked]);

  if (!status || !prefs) return null;

  const fail = (code: string) => setNote(code === 'rate_limited' ? 'rateLimited' : 'error');

  async function toggle(k: TelegramType, on: boolean) {
    const before = prefs!;
    setPrefs({ ...before, [k]: on });
    setNote(null);
    if (!status!.linked) return; // not linked yet: the choice travels with the Connect request
    const r = await updateTelegramLink({ prefs: { [k]: on }, locale: lang });
    if (!alive.current) return;
    if (r.ok) { setStatus(r.data); setNote('saved'); } else { setPrefs(before); fail(r.code); }
  }

  async function connect() {
    setBusy(true);
    setNote(null);
    const r = await startTelegramLink({ locale: lang, prefs: prefs! });
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) return fail(r.code);
    setPending({ url: r.data.url, expiresAt: Date.parse(r.data.expiresAt) });
    window.open(r.data.url, '_blank', 'noopener,noreferrer'); // may be blocked: the Open Telegram button next to it is the fallback
  }

  async function disconnect() {
    setBusy(true);
    setNote(null);
    const r = await unlinkTelegram();
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) return fail(r.code);
    await load();
  }

  return <TelegramView status={status} prefs={prefs} pending={pending} busy={busy} note={note} onToggle={(k, on) => void toggle(k, on)} onConnect={() => void connect()} onDisconnect={() => void disconnect()} />;
}
