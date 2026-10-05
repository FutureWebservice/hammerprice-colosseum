'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { z } from 'zod';
import type { AiAgentCard, AiListingResponse } from '@/contracts';
import { AiCallError, errorKey, postListing } from './client';
import { clock, usdc } from './live';
import './agent.css';

type Card = z.infer<typeof AiAgentCard>;
type LotCardData = Extract<Card, { type: 'lots' }>['lots'][number];
type Lang = 'de' | 'en';

/** Nothing here acts on its own: a lot card links to the room, a bid card only links to the room (the bid is placed there, with the user's own wallet), a draft card calls the listing route only when its button is pressed. */
export function CardView({ card, lang, onPrepareBid }: { card: Card; lang: Lang; onPrepareBid?: (lot: LotCardData) => void }) {
  if (card.type === 'lots') {
    return (
      <ul className="agc-lots" data-testid="ai-agent-lots">
        {card.lots.map((l) => <LotCard key={l.lotId} lot={l} lang={lang} {...(onPrepareBid ? { onPrepareBid } : {})} />)}
      </ul>
    );
  }
  return card.type === 'bid' ? <BidCard card={card} lang={lang} /> : <DraftCard card={card} lang={lang} />;
}

/** A picture only from our own storage or an https address (the URL comes from the seller's data). */
const safeImage = (u: string | null): string | null => (u && /^(https:\/\/|\/)/.test(u) ? u : null);

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

function LotCard({ lot: l, lang, onPrepareBid }: { lot: LotCardData; lang: Lang; onPrepareBid?: (lot: LotCardData) => void }) {
  const t = useTranslations('ai');
  const open = l.state === 'open';
  const closes = open && l.closesAt ? new Date(l.closesAt).getTime() : null;
  const now = useNow(closes !== null);
  const img = safeImage(l.imageUrl);
  const starts = l.startsAt ? new Date(l.startsAt) : null;
  return (
    <li className="agc-lot" data-testid="ai-agent-lot">
      <div className="agc-lot-img">
        {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
        {img ? <img src={img} alt={l.name} loading="lazy" decoding="async" /> : <span aria-hidden="true">{t('agent.noPhoto')}</span>}
      </div>
      <div className="agc-lot-body">
        <div className="agc-lot-top">
          <span className={`agc-pill ${open ? 'agc-pill--open' : ''}`}>{open ? t('agent.open') : t('agent.soon')}</span>
          <span className="agc-lot-no">{t('agent.lot', { n: l.lotNumber })} · {l.showTitle}</span>
        </div>
        <div className="agc-lot-name">{l.name}</div>
        <div className="agc-lot-meta">
          {l.grading && <span className="agc-grade">{l.grading}</span>}
          {l.setName && <span>{l.setName}</span>}
        </div>
        <div className="agc-lot-price"><strong>{usdc(l.priceUsdc)} USDC</strong> <span>{l.hasBid ? t('agent.currentBid') : t('agent.opening')}</span></div>
        <div className="agc-lot-time">
          {closes !== null
            ? <span role="timer">{t('agent.timeLeft', { time: clock(Math.max(0, closes - now)) })}</span>
            : !open && starts && !Number.isNaN(starts.getTime())
              ? <span>{t('agent.startsOn', { when: starts.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>
              : !open && l.showStatus === 'scheduled' ? <span>{t('agent.startsLater')}</span> : null}
        </div>
        <div className="agc-actions">
          <a className="ai-btn ai-btn--primary" href={`/${lang}/room/${l.showId}`}>{t('agent.openRoom')}</a>
          {open && onPrepareBid && <button type="button" className="ai-btn" onClick={() => onPrepareBid(l)}>{t('agent.prepareBid')}</button>}
        </div>
      </div>
    </li>
  );
}

function BidCard({ card, lang }: { card: Extract<Card, { type: 'bid' }>; lang: Lang }) {
  const t = useTranslations('ai');
  const min = BigInt(card.amountUsdc), max = BigInt(card.limitUsdc);
  const step = BigInt(card.incrementUsdc) > 0n ? BigInt(card.incrementUsdc) : 1_000_000n;
  const [amt, setAmt] = useState(min);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(usdc(amt.toString())).then(() => setCopied(true), () => undefined);
    } catch { /* no clipboard here: the amount is on screen */ }
  };
  return (
    <section className="agc-card agc-bid" aria-label={t('agent.bidTitle')} data-testid="ai-agent-bid">
      <span className="ai-badge">{t('agent.bidTitle')}</span>
      <div className="agc-lot-name">{t('agent.lot', { n: card.lotNumber })}: {card.name}</div>
      <dl className="agc-facts">
        <div><dt>{t('agent.bidCurrent')}</dt><dd>{card.currentBidUsdc ? `${usdc(card.currentBidUsdc)} USDC` : t('agent.bidNone')}</dd></div>
        <div><dt>{t('agent.bidLimit')}</dt><dd>{usdc(card.limitUsdc)} USDC</dd></div>
      </dl>
      <div className="agc-step" role="group" aria-label={t('agent.bidAmount')}>
        <button type="button" className="agc-step-btn" aria-label={t('agent.bidDown')} disabled={amt - step < min} onClick={() => { setAmt(amt - step < min ? min : amt - step); setCopied(false); }} data-testid="ai-agent-bid-down">−</button>
        <output className="agc-step-val" data-testid="ai-agent-bid-amount">{usdc(amt.toString())} USDC</output>
        <button type="button" className="agc-step-btn" aria-label={t('agent.bidUp')} disabled={amt + step > max} onClick={() => { setAmt(amt + step > max ? max : amt + step); setCopied(false); }} data-testid="ai-agent-bid-up">+</button>
        <span className="agc-step-note">{t('agent.bidStep', { step: usdc(step.toString()) })}</span>
      </div>
      <div className="agc-note">{t('agent.bidNote')} {t('agent.bidThere')}</div>
      <div className="agc-actions">
        <a className="ai-btn ai-btn--primary" href={`/${lang}/room/${card.showId}`} data-testid="ai-agent-bid-confirm">{t('agent.bidConfirm')}</a>
        <button type="button" className="ai-btn" onClick={copy}>{t('agent.bidCopy')}</button>
        {copied && <span role="status" className="agc-ok">{t('agent.bidCopied')}</span>}
      </div>
    </section>
  );
}

function DraftCard({ card, lang }: { card: Extract<Card, { type: 'draft' }>; lang: Lang }) {
  const t = useTranslations('ai');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<z.infer<typeof AiListingResponse> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const f = card.fields;
  const free = card.creditCost === 0;

  async function create() {
    setBusy(true); setErr(null);
    try {
      setRes(await postListing({ requestId: crypto.randomUUID(), fields: { ...f, locale: lang } }));
    } catch (e) {
      setErr(e instanceof AiCallError && e.code === 'payment_required' ? 'agent.noCredit' : e instanceof AiCallError && (e.code === 'unauthenticated' || e.code === 'banned') ? 'agent.signIn' : errorKey(e, 'listing'));
    } finally { setBusy(false); }
  }

  return (
    <section className="agc-card agc-draft" aria-label={t('agent.draftTitle')} data-testid="ai-agent-draft">
      <span className="ai-badge">{t('agent.draftTitle')}</span>
      <dl className="agc-facts">
        <div><dt>{t('agent.draftName')}</dt><dd>{f.name}</dd></div>
        {f.setName && <div><dt>{t('agent.draftSet')}</dt><dd>{f.setName}</dd></div>}
        {(f.gradingCompany || f.grade) && <div><dt>{t('agent.draftGrade')}</dt><dd>{[f.gradingCompany, f.grade].filter(Boolean).join(' ')}</dd></div>}
        {f.estimateUsdc && <div><dt>{t('agent.draftEstimate')}</dt><dd>{usdc(f.estimateUsdc)} USDC</dd></div>}
      </dl>
      <div className="agc-note">{free ? t('agent.draftNoteFree') : t('agent.draftNote')}</div>
      {!res && <div className="agc-actions"><button type="button" className="ai-btn ai-btn--primary" onClick={() => void create()} disabled={busy} data-testid="ai-agent-draft-create">{busy ? t('agent.draftCreating') : free ? t('agent.draftCreateFree') : t('agent.draftCreate')}</button></div>}
      {err && <div className="ai-err" role="alert" data-testid="ai-agent-draft-error">{t(err)}</div>}
      {res && (
        <div className="agc-draft-result" data-testid="ai-agent-draft-result">
          <span className={`ai-badge ${res.source === 'model' ? '' : 'ai-badge--template'}`}>{res.source === 'model' ? t('badge.draft') : t('badge.template')}</span>
          <dl className="agc-facts agc-facts--stack">
            <div><dt>{t('agent.draftTitles')}</dt><dd>{lang === 'de' ? res.draft.titleDe : res.draft.titleEn}</dd></div>
            <div><dt>{t('agent.draftDe')}</dt><dd>{res.draft.descriptionDe}</dd></div>
            <div><dt>{t('agent.draftEn')}</dt><dd>{res.draft.descriptionEn}</dd></div>
          </dl>
          {!free && <div className="agc-note">{t('agent.draftCredits', { count: res.creditsLeft })}</div>}
          <div className="agc-actions"><a className="ai-btn" href={`/${lang}/sell/new`}>{t('agent.draftSell')}</a></div>
        </div>
      )}
    </section>
  );
}
