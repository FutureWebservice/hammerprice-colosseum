'use client';

/**
 * /packs/manage: the operator's side. Define a pack of cards you own (a draft), publish it (the pool is fixed for good), pause or close it,
 * sign the equal-value sales that wait for you, and DELIVER the cards of your chance packs (the buyer paid you directly; you sign the transfer of the
 * drawn card to the buyer before the deadline). Nothing here touches a card or money: it only calls the pack API and asks your wallet to sign the exact
 * transaction, which it first decodes and checks.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { VersionedTransaction } from '@solana/web3.js';
import type { PackDeliveryItem, PackDrawView, PackView } from '@/contracts';
import { useSession, useSignIn } from '@/components/auth/SessionProvider';
import SignInNotice from '@/components/auth/SignInNotice';
import ConnectWalletButton from '@/components/room/ConnectWalletButton';
import { Link } from '@/lib/i18n';
import { clientCluster } from '@/lib/client/cluster-text';
import { SettleError } from '@/lib/client/settle';
import { classifyWalletError } from '@/lib/client/bidder';
import { signPackPayment } from '@/lib/packs/client';
import { controlPack, createPack, getDraws, myDeliveries, myPacks, prepareDraw, signDraw } from './api';
import { useAssets } from '@/components/sell/useAssets';
import OddsBar from './OddsBar';
import { accessKey, OfferPackExplainer, useOperatorAccess } from './OfferPack';
import { cardLine, parsePackForm, previewOdds, START, switchMode, type FormInput } from './form';
import { errorKey } from './purchase';
import { shortAddress, usd } from './format';
import { formatBps } from '@/lib/packs/rarity';
import { usePackT } from './usePackT';
import './packs.css';


/** The chance sales that wait for YOUR delivery: the drawn card is shown here (to you only), and your wallet signs its transfer to the buyer. */
function Deliveries({ locale }: { locale: 'de' | 'en' }) {
  const t = usePackT();
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [items, setItems] = useState<PackDeliveryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ key: string; ok: boolean } | null>(null);

  const load = useCallback(async () => { const r = await myDeliveries(); if (r.ok) setItems(r.data.deliveries); }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  const deliver = async (item: PackDeliveryItem) => {
    if (!wallet || !signTransaction) return;
    setBusy(item.draw.id);
    setMessage(null);
    try {
      const prepared = await prepareDraw(item.draw.id);
      if (!prepared.ok) { setMessage({ key: `errors.${errorKey(prepared.code)}`, ok: false }); return; }
      const { signedTxBase64 } = await signPackPayment(prepared.data, { role: 'seller', myWallet: wallet, cluster: clientCluster(), signTransaction: (tx: VersionedTransaction) => signTransaction(tx) });
      const res = await signDraw(item.draw.id, { role: 'seller', signedTxBase64 });
      setMessage(res.ok ? { key: 'manage.delivered', ok: true } : { key: `errors.${errorKey(res.code)}`, ok: false });
      void load();
    } catch (e) {
      setMessage({ key: e instanceof SettleError ? `errors.${errorKey(e.kind === 'wallet' ? 'wallet' : e.kind, { wallet: e.kind === 'wallet' ? classifyWalletError(e.detail?.cause) : undefined })}` : 'errors.generic', ok: false });
    } finally {
      setBusy(null);
    }
  };
  const when = (iso: string | null) => (iso ? `${new Date(iso).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` : '');

  return (
    <section className="pk-section" aria-labelledby="deliveries-h" data-testid="operator-deliveries">
      <h2 id="deliveries-h">{t('manage.deliveries')}</h2>
      <p className="pk-note">{t('manage.deliverNote')}</p>
      {items.length === 0 ? <p className="pk-note">{t('manage.deliveriesNone')}</p> : (
        <div className="pk-rows">
          {items.map((i) => (
            <div key={i.draw.id} className="pk-row" data-testid="delivery-item" data-late={i.late ? 'true' : 'false'}>
              <span>{t('manage.deliveryItem', { card: i.card.name, address: shortAddress(i.draw.buyer), time: when(i.deliverBy) })} {i.late && <strong className="pk-status--error">{t('manage.deliverLate')}</strong>}</span>
              <button type="button" className="pk-btn pk-btn--small" disabled={busy !== null} onClick={() => void deliver(i)}>{busy === i.draw.id ? t('manage.signing') : t('manage.deliver')}</button>
            </div>
          ))}
        </div>
      )}
      {message && <p className={`pk-status ${message.ok ? 'pk-status--ok' : 'pk-status--error'}`} role="status">{t(message.key)}</p>}
    </section>
  );
}

function Queue({ packs, locale }: { packs: PackView[]; locale: 'de' | 'en' }) {
  const t = usePackT();
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [items, setItems] = useState<{ pack: PackView; draw: PackDrawView }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ key: string; ok: boolean } | null>(null);
  const live = packs.filter((p) => p.status === 'live' || p.status === 'paused');
  const ids = live.map((p) => p.id).join(',');

  useEffect(() => {
    if (!ids) { setItems([]); return undefined; }
    let stopped = false;
    const tick = async () => {
      const found: { pack: PackView; draw: PackDrawView }[] = [];
      for (const p of live) {
        const r = await getDraws(p.id, 20);
        if (r.ok) for (const d of r.data.draws) if (d.status === 'reserved') found.push({ pack: p, draw: d });
      }
      if (!stopped) setItems(found);
    };
    void tick();
    const id = setInterval(() => void tick(), 6000);
    return () => { stopped = true; clearInterval(id); };
    // `live` follows `ids`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  const sign = async (item: { pack: PackView; draw: PackDrawView }) => {
    if (!wallet || !signTransaction) return;
    setBusy(item.draw.id);
    setMessage(null);
    try {
      const prepared = await prepareDraw(item.draw.id);
      if (!prepared.ok) { setMessage({ key: `errors.${errorKey(prepared.code)}`, ok: false }); return; }
      const { signedTxBase64 } = await signPackPayment(prepared.data, { role: 'seller', myWallet: wallet, cluster: clientCluster(), signTransaction: (tx: VersionedTransaction) => signTransaction(tx) });
      const res = await signDraw(item.draw.id, { role: 'seller', signedTxBase64 });
      setMessage(res.ok ? { key: 'manage.signed', ok: true } : { key: `errors.${errorKey(res.code)}`, ok: false });
    } catch (e) {
      setMessage({ key: e instanceof SettleError ? `errors.${errorKey(e.kind === 'wallet' ? 'wallet' : e.kind, { wallet: e.kind === 'wallet' ? classifyWalletError(e.detail?.cause) : undefined })}` : 'errors.generic', ok: false });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pk-section" aria-labelledby="queue-h" data-testid="operator-queue">
      <h2 id="queue-h">{t('manage.queue')}</h2>
      {items.length === 0 ? <p className="pk-note">{t('manage.queueNone')}</p> : (
        <div className="pk-rows">
          {items.map((i) => (
            <div key={i.draw.id} className="pk-row" data-testid="queue-item">
              <span>{t('manage.queueItem', { address: shortAddress(i.draw.buyer) })} <span className="pk-mono">{usd(i.draw.price, locale)}</span></span>
              <button type="button" className="pk-btn pk-btn--small" disabled={busy !== null} onClick={() => void sign(i)}>{busy === i.draw.id ? t('manage.signing') : t('manage.sign')}</button>
            </div>
          ))}
        </div>
      )}
      {message && <p className={`pk-status ${message.ok ? 'pk-status--ok' : 'pk-status--error'}`} role="status">{t(message.key)}</p>}
    </section>
  );
}

/** The signed-in wallet's cards that can go into a pool: one click adds a line to the pool text (with the first tier of the odds; change it in the text). */
function WalletCards({ onAdd, added }: { onAdd: (c: { mint: string; name: string; imageUrl: string | null }) => void; added: ReadonlySet<string> }) {
  const t = usePackT();
  const { state } = useAssets();
  if (state.status === 'loading') return <p className="pk-note">{t('loading')}</p>;
  if (state.status === 'error') return <p className="pk-note">{t('manage.noCards')}</p>;
  const eligible = state.assets.filter((a) => a.eligible);
  if (eligible.length === 0) return <p className="pk-note" data-testid="wallet-cards-none">{t('manage.noCards')}</p>;
  return (
    <div data-testid="wallet-cards">
      <p className="pk-help">{t('manage.pickNote')}</p>
      <div className="pk-wallet-cards">
        {eligible.map((a) => (
          <div key={a.mint} className="pk-wallet-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
            {a.imageUrl ? <img src={a.imageUrl} alt="" loading="lazy" decoding="async" /> : null}
            <span>{a.name}</span>
            <button type="button" className="pk-btn pk-btn--ghost pk-btn--small" disabled={added.has(a.mint)} onClick={() => onAdd({ mint: a.mint, name: a.name, imageUrl: a.imageUrl })}>{added.has(a.mint) ? t('manage.added') : t('manage.add')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ManagePacks({ locale }: { locale: 'de' | 'en' }) {
  const t = usePackT();
  const { connected } = useWallet();
  const { status } = useSession();
  const { signIn, pending } = useSignIn();
  const [packs, setPacks] = useState<PackView[] | null>(null);
  const [form, setForm] = useState<FormInput>(START);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const access = accessKey(useOperatorAccess());
  const blocked = access.allowed === false;
  const preview = previewOdds(form.odds);
  const added = new Set(form.cards.split('\n').map((l) => l.split(';')[0]!.trim()).filter(Boolean));

  const load = useCallback(async () => {
    const r = await myPacks();
    if (r.ok) setPacks(r.data.packs);
    else if (r.code === 'feature_off') setOff(true);
  }, []);
  useEffect(() => { if (status === 'signed-in') void load(); }, [status, load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    const r = parsePackForm(form);
    if (!r.ok) {
      setIssues([...(r.oddsSum !== undefined ? [t('manage.oddsSum', { sum: r.oddsSum })] : []), ...r.issues.map((i) => t('manage.invalid', { line: i.line || '-', why: i.why }))]);
      return;
    }
    setIssues([]);
    setSaving(true);
    const res = await createPack(r.request);
    setSaving(false);
    if (!res.ok) { setIssues([t(`errors.${errorKey(res.code)}`) + (res.reason && res.code !== 'already_listed' ? ` (${res.reason})` : '')]); return; }
    setNote(t('manage.created'));
    setForm(START);
    void load();
  };
  const act = async (id: string, action: 'publish' | 'pause' | 'resume' | 'close') => {
    const r = await controlPack(id, action);
    if (!r.ok) setIssues([t(`errors.${errorKey(r.code)}`) + (r.reason ? ` (${r.reason})` : '')]);
    else setIssues([]);
    void load();
  };
  const set = (k: keyof FormInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="hp pk" data-testid="manage-page">
      <header className="pk-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('manage.kicker')}</p>
        <h1 className="hp-h1">{t('manage.title')}</h1>
        <p className="pk-lede">{t('manage.lede')}</p>
        <p style={{ marginTop: 14 }}><Link href="/packs" className="pk-link">{t('back')}</Link></p>
      </header>
      <div className="pk-wrap">
        {off && <p className="pk-state pk-state--error" role="alert">{t('manage.unavailable')}</p>}
        {!off && <OfferPackExplainer cta={false} />}
        {!off && status !== 'signed-in' && (
          <div className="pk-buy" style={{ maxWidth: 520 }}>
            <p style={{ margin: 0 }}>{t('manage.signIn')}</p>
            {!connected ? <ConnectWalletButton /> : <button type="button" className="pk-btn" disabled={pending} onClick={() => void signIn()}>{pending ? t('buy.signingIn') : t('buy.signIn')}</button>}
            <SignInNotice />
          </div>
        )}
        {!off && status === 'signed-in' && (
          <>
            <section className="pk-section" aria-labelledby="mine-h">
              <h2 id="mine-h">{t('manage.mine')}</h2>
              {packs === null ? <p className="pk-state">{t('loading')}</p> : packs.length === 0 ? <p className="pk-note">{t('manage.none')}</p> : (
                <div className="pk-rows">
                  {packs.map((p) => (
                    <div key={p.id} className="pk-row" data-testid="my-pack" data-status={p.status}>
                      <span><strong>{p.name[locale]}</strong> <span className={`pk-badge pk-badge--${p.status}`}>{t(`status.${p.status}`)}</span> <span className="pk-mono">{usd(p.price, locale)}</span> <span className="pk-note">{p.pool.remaining}/{p.pool.total}</span></span>
                      <span className="pk-row-actions">
                        {p.status === 'draft' && <button type="button" className="pk-btn pk-btn--small" onClick={() => void act(p.id, 'publish')} title={t('manage.publishWarn')}>{t('manage.publish')}</button>}
                        {p.status === 'live' && <button type="button" className="pk-btn pk-btn--ghost pk-btn--small" onClick={() => void act(p.id, 'pause')}>{t('manage.pause')}</button>}
                        {p.status === 'paused' && <button type="button" className="pk-btn pk-btn--ghost pk-btn--small" onClick={() => void act(p.id, 'resume')}>{t('manage.resume')}</button>}
                        {p.status !== 'closed' && <button type="button" className="pk-btn pk-btn--ghost pk-btn--small" onClick={() => void act(p.id, 'close')}>{t('manage.close')}</button>}
                        {p.status !== 'draft' && <Link className="pk-btn pk-btn--ghost pk-btn--small" href={`/packs/${p.id}`}>{t('manage.open')}</Link>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            {packs && <Deliveries locale={locale} />}
            {packs && <Queue packs={packs} locale={locale} />}
            <section className="pk-section" aria-labelledby="new-h">
              <h2 id="new-h">{t('manage.create')}</h2>
              <form className="pk-form" onSubmit={(e) => void submit(e)} noValidate>
                <div className="pk-two">
                  <div className="pk-field"><label htmlFor="pk-name-de">{t('manage.nameDe')}</label><input id="pk-name-de" value={form.nameDe} onChange={set('nameDe')} maxLength={120} /></div>
                  <div className="pk-field"><label htmlFor="pk-name-en">{t('manage.nameEn')}</label><input id="pk-name-en" value={form.nameEn} onChange={set('nameEn')} maxLength={120} /></div>
                </div>
                <div className="pk-two">
                  <div className="pk-field"><label htmlFor="pk-price">{t('manage.price')}</label><input id="pk-price" inputMode="decimal" value={form.price} onChange={set('price')} /></div>
                  <div className="pk-field"><label htmlFor="pk-cap">{t('manage.cap')}</label><input id="pk-cap" inputMode="numeric" value={form.cap} onChange={set('cap')} /></div>
                </div>
                <div className="pk-field">
                  <label htmlFor="pk-mode">{t('manage.mode')}</label>
                  <select id="pk-mode" value={form.mode} onChange={(e) => setForm((f) => switchMode(f, e.target.value as FormInput['mode']))}><option value="equal_value">{t('mode.equal_value')}</option><option value="chance">{t('mode.chance')}</option></select>
                  {form.mode === 'chance' && <p className="pk-help" data-testid="chance-note">{t('manage.chanceNote')}</p>}
                </div>
                <div className="pk-field"><label htmlFor="pk-odds">{t('manage.odds')}</label><textarea id="pk-odds" value={form.odds} onChange={set('odds')} placeholder="common; Häufig; Common; 70" spellCheck={false} /><p className="pk-help">{t('manage.oddsHelp')}</p>
                  {preview.rows.length > 0 && (
                    <div className="pk-preview" data-testid="odds-preview">
                      <OddsBar odds={preview.rows} locale={locale} compact />
                      <span className="pk-preview-sum" data-ok={preview.sumBps === 10_000} data-testid="odds-preview-sum">{t('manage.oddsTotal', { sum: formatBps(preview.sumBps, locale) })}</span>
                    </div>
                  )}
                </div>
                <div className="pk-field"><span className="pk-label">{t('manage.pickCards')}</span><WalletCards added={added} onAdd={(c) => setForm((f) => ({ ...f, cards: `${f.cards.trim() ? `${f.cards.trimEnd()}\n` : ''}${cardLine(c, previewOdds(f.odds).rows[0]?.tier ?? '')}` }))} /></div>
                <div className="pk-field"><label htmlFor="pk-cards">{t('manage.cards')}</label><textarea id="pk-cards" value={form.cards} onChange={set('cards')} placeholder="2RvovZc...; common; Card name; https://...; 25" spellCheck={false} style={{ minHeight: 180 }} /><p className="pk-help">{t('manage.cardsHelp')}</p></div>
                {issues.length > 0 && <ul className="pk-status pk-status--error" role="alert" data-testid="form-issues" style={{ paddingLeft: 18 }}>{issues.map((m, i) => <li key={i}>{m}</li>)}</ul>}
                {note && <p className="pk-status pk-status--ok" role="status">{note}</p>}
                {blocked && <p className="pk-status pk-status--error" role="alert" data-testid="create-blocked">{t('manage.notAllowed')}</p>}
                <div><button type="submit" className="pk-btn" disabled={saving || blocked} data-testid="create-submit">{saving ? t('manage.saving') : t('manage.submit')}</button></div>
              </form>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
