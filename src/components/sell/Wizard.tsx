'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/lib/i18n';
import type { SellAsset } from '@/contracts/api';
import { createShow, getSellAssets, goLive } from './api';
import SignInGate from './SignInGate';
import Tour from '@/components/tour/Tour';
import { markHintConfirmed } from '@/components/explain/WalletPromptHint';
import { useAssets } from './useAssets';
import { useApiError } from './useApiError';
import { rememberShow } from './recent';
import { Nav, PickStep, PriceStep, StepBar, TimeStep } from './WizardViews';
import {
  STEPS, applyAssets, autoTitle, buildCreateRequest, initialState, markChecking, markError, setAllTerms, setDescription, setLotDuration, setTerm, togglePick, withTitle,
  type TermField, type WizardState,
} from './wizardState';
import './sell.css';

const RECHECK_CODES = new Set(['not_owner', 'unsupported_standard', 'frozen', 'asset_not_ready', 'already_listed']);

function Inner() {
  const t = useTranslations('sell');
  const errorText = useApiError();
  const router = useRouter();
  const { state: assets, reload } = useAssets();
  const [s, setS] = useState<WizardState>(() => initialState(new Date()));
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Time is read when an event happens, never during render, so the page renders the same on server and client.
  const [now, setNow] = useState(() => new Date());

  const check = useCallback(async () => {
    setNow(new Date());
    setS((x) => markChecking(x));
    const r = await getSellAssets();
    setS((x) => (r.ok ? applyAssets(x, r.data.assets) : markError(x, r.code)));
    if (r.ok) markHintConfirmed('consign'); // the card check ran without any wallet prompt: from now on the note is one quiet line
  }, []);

  const go = (delta: 1 | -1) => {
    const next = STEPS[STEPS.indexOf(s.step) + delta];
    if (!next) return;
    setNow(new Date());
    setS({ ...s, step: next });
    if (next === 'time') void check();
  };

  const label = (name: string, count: number) => t('wizard.autoTitle', { name, count, more: count - 1 });
  const fallback = t('wizard.autoTitleFallback');
  // The title the seller typed, or the generated one. Every rule and the request see this one.
  const eff = withTitle(s, label, fallback);

  async function publish() {
    const fresh = new Date();
    setNow(fresh);
    const body = buildCreateRequest(eff, fresh);
    if (!body) {
      setPublishError(t('wizard.publish.invalid'));
      return;
    }
    setPublishing(true);
    setPublishError(null);
    const r = await createShow(body);
    setPublishing(false);
    if (r.ok) {
      rememberShow({ id: r.data.show.id, title: r.data.show.title });
      // "Start now": open the room right away. If that fails the manage page still has the Start button.
      if (eff.when === 'now') await goLive(r.data.show.id);
      router.push(`/sell/${r.data.show.id}`);
      return;
    }
    setPublishError(errorText(r) + (r.reason && r.code !== 'already_listed' ? ` (${r.reason})` : '')); // already_listed: the message says it all, the server's reason is English
    if (RECHECK_CODES.has(r.code)) void check();
  }

  if (assets.status === 'loading') return <p className="sl-note" role="status">{t('assets.loading')}</p>;
  if (assets.status === 'error') {
    return (
      <div className="sl-warn" role="alert" data-testid="assets-error">
        <p>{assets.error.code === 'rpc_unavailable' ? t('assets.rpcDown') : errorText(assets.error)}</p>
        <button type="button" className="sl-btn" onClick={() => void reload()}>{t('assets.retry')}</button>
      </div>
    );
  }

  const pick = (a: SellAsset) => setS((x) => togglePick(x, a));
  return (
    <>
      <Tour flow="sell" />
      <StepBar step={s.step} />
      <div data-tour="sell-step">
      {s.step === 'pick' && <PickStep assets={assets.assets} state={s} onToggle={pick} onMinted={() => void reload()} />}
      {s.step === 'price' && <PriceStep state={s} onChange={(f: TermField, v) => setS((x) => setAllTerms(x, f, v))} onChangeLot={(mint, f, v) => setS((x) => setTerm(x, mint, f, v))} onApplyListing={(mint, p) => setS((x) => setDescription(x, mint, p.description, p.aiAssisted, p.opening))} />}
      {s.step === 'time' && (
        <TimeStep
          state={eff} titleInput={s.title} autoTitle={autoTitle(s.lots, label, fallback)} now={now} publishing={publishing} publishError={publishError}
          onWhen={(when) => { setNow(new Date()); setS((x) => ({ ...x, when })); }}
          onStart={(start) => { setNow(new Date()); setS((x) => ({ ...x, start })); }}
          onTitle={(title) => setS((x) => ({ ...x, title }))}
          onDuration={(d) => setS((x) => ({ ...x, kind: d.kind, durationS: d.durationS }))}
          onVideo={(videoEnabled) => setS((x) => ({ ...x, videoEnabled }))}
          onLotDuration={(seconds) => setS((x) => setLotDuration(x, seconds))}
          onCheck={() => void check()} onPublish={() => void publish()}
        />
      )}
      </div>
      <Nav state={eff} onBack={() => go(-1)} onNext={() => go(1)} />
    </>
  );
}

export default function Wizard() {
  const t = useTranslations('sell');
  return (
    <div className="hp sl">
      <header className="sl-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="sl-h1">{t('wizard.title')}</h1>
        <p className="sl-note"><Link href="/sell">{t('wizard.backToSell')}</Link></p>
      </header>
      <SignInGate>
        <Inner />
      </SignInGate>
    </div>
  );
}
