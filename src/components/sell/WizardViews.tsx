'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { SellAsset } from '@/contracts/api';
import type { LotDescription, ShowKind } from '@/contracts/common';
import Advanced from '@/components/explain/Advanced';
import Term from '@/components/glossary/Term';
import WalletPromptHint from '@/components/explain/WalletPromptHint';
import ListingAssist from './slots/ListingAssist';
import DurationPicker from './slots/DurationPicker';
import VideoOption from './slots/VideoOption';
import AssetGrid from './AssetGrid';
import MintCard from './MintCard';
import { useReasonText } from './useApiError';
import { IS_DEVNET } from './chain-links';
import { formatWhen, localInputToIso } from './datetime';
import { formatUsdc, parseUsdc } from './money';
import { formatDurationLong, formatDurationS } from '@/lib/auction/time-format';
import { RULE_DEFAULTS } from '@/lib/auction/rules';
import {
  STEPS, MAX_LOTS, LOT_DURATION_PRESETS_S, allReady, canLeave, canPublish, firstTermIssue, isChecking, lotDurationOf, lotIssues, sharedTerm, showIssues,
  type LotDraft, type Readiness, type Step, type TermField, type WhenMode, type WizardState,
} from './wizardState';

/** Step list with the current step marked. */
export function StepBar({ step }: { step: Step }) {
  const t = useTranslations('sell');
  const at = STEPS.indexOf(step);
  return (
    <ol className="sl-steps" aria-label={t('wizard.stepsLabel')} data-testid="step-bar" data-tour="sell-steps">
      {STEPS.map((s, i) => (
        <li key={s} className={i === at ? 'is-current' : i < at ? 'is-done' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="sl-step-n" aria-hidden="true">{i < at ? '\u2713' : i + 1}</span>
          <span className="sl-step-name">{t(`wizard.steps.${s}`)}</span>
          {i === at && <span className="sl-sr"> ({t('wizard.stepOf', { current: i + 1, total: STEPS.length })})</span>}
        </li>
      ))}
    </ol>
  );
}

/** Step 1. On devnet a visitor with no card gets a clear "Get a test card" button right here. */
export function PickStep({ assets, state, onToggle, onMinted }: { assets: SellAsset[]; state: WizardState; onToggle: (a: SellAsset) => void; onMinted?: () => void }) {
  const t = useTranslations('sell');
  const picked = new Set(state.lots.map((l) => l.mint));
  const eligible = assets.filter((a) => a.eligible).length;
  return (
    <section>
      <h2 className="sl-h2">{t('wizard.pick.title')}</h2>
      <p className="sl-note">{t('wizard.pick.body', { max: MAX_LOTS })}</p>
      {assets.length === 0 ? (
        <div className="sl-empty" data-testid="pick-empty">
          <h3 className="sl-empty-title">{t('wizard.pick.emptyTitle')}</h3>
          <p>{IS_DEVNET ? t('wizard.pick.emptyDevnet') : t('wizard.pick.empty')}</p>
        </div>
      ) : eligible === 0 && <p className="sl-warn" data-testid="pick-none-eligible">{t('wizard.pick.noneEligible')}</p>}
      <AssetGrid assets={assets} picked={picked} onToggle={onToggle} />
      <p className="sl-note" role="status" data-testid="pick-count">{t('wizard.pick.count', { count: state.lots.length, max: MAX_LOTS })}</p>
      {IS_DEVNET && onMinted && <MintCard onMinted={onMinted} />}
    </section>
  );
}

const issueKey = (issue: string) => `wizard.terms.issues.${issue === 'reserve_below_opening' ? issue : `amount_${issue}`}`;

function Field({ field, value, differs, issue, testId, id, onChange }: {
  field: TermField; value: string; differs?: boolean; issue: string | null; testId: string; id: string; onChange: (v: string) => void;
}) {
  const t = useTranslations('sell');
  return (
    <label className="sl-field">
      <span>{field === 'reserve' ? <Term id="reserve">{t(`wizard.terms.${field}`)}</Term> : t(`wizard.terms.${field}`)}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={differs ? t('wizard.terms.differs') : field === 'reserve' ? t('wizard.terms.noReserve') : undefined}
        aria-invalid={issue ? true : undefined}
        aria-describedby={`${id}-hint`}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
      <small id={`${id}-hint`} className={issue ? 'sl-err' : 'sl-hint'} data-testid={issue ? `${testId.replace('-input', '')}-issue` : undefined}>
        {issue ? t(issueKey(issue)) : t(`wizard.terms.${field}Hint`)}
      </small>
    </label>
  );
}

/** Step 2: two fields. The bid step and per-card prices wait behind "Advanced options". */
export function PriceStep({ state, onChange, onChangeLot, onApplyListing }: {
  state: WizardState;
  onChange: (field: TermField, value: string) => void;
  onChangeLot: (mint: string, field: TermField, value: string) => void;
  onApplyListing?: (mint: string, patch: { description: LotDescription; aiAssisted: boolean; opening?: string }) => void;
}) {
  const t = useTranslations('sell');
  const locale = useLocale();
  const many = state.lots.length > 1;
  const shown = (f: TermField) => sharedTerm(state, f);
  return (
    <section>
      <h2 className="sl-h2">{t('wizard.price.title')}</h2>
      <p className="sl-note">{many ? t('wizard.price.bodyMany', { count: state.lots.length }) : t('wizard.price.body')}</p>
      <p className="sl-note sl-fee" data-testid="price-fee">{t('wizard.price.fee')}</p>
      <div className="sl-fields" data-testid="price-fields">
        {(['opening', 'reserve'] as const).map((f) => (
          <Field key={f} field={f} id={`all-${f}`} testId={`${f}-input`} value={shown(f) ?? ''} differs={shown(f) === null} issue={firstTermIssue(state, f)} onChange={(v) => onChange(f, v)} />
        ))}
      </div>
      <ListingAssist lots={state.lots} locale={locale} onApply={onApplyListing ?? (() => {})} />
      <Advanced id="price" className="sl-adv" bodyClassName="sl-adv-body">
          <Field field="increment" id="all-increment" testId="increment-input" value={shown('increment') ?? ''} differs={shown('increment') === null} issue={firstTermIssue(state, 'increment')} onChange={(v) => onChange('increment', v)} />
          {many && (
            <>
              <h3 className="sl-h3">{t('wizard.price.perCard')}</h3>
              <ul className="sl-lots">
                {state.lots.map((l, i) => {
                  const issues = lotIssues(l);
                  return (
                    <li key={l.mint} className="sl-lot" data-testid="lot-terms" data-mint={l.mint}>
                      <div className="sl-lot-head">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
                        {l.imageUrl ? <img className="sl-lot-img" src={l.imageUrl} alt="" loading="lazy" decoding="async" /> : <div className="sl-lot-img sl-card-img--empty" aria-hidden="true" />}
                        <div>
                          <p className="sl-lot-no">{t('wizard.terms.lotNo', { number: i + 1 })}</p>
                          <h4 className="sl-card-name">{l.name}</h4>
                        </div>
                      </div>
                      <div className="sl-fields">
                        {(['opening', 'reserve'] as const).map((f) => (
                          <Field key={f} field={f} id={`${l.mint}-${f}`} testId={`lot-${f}-input`} value={l[f]} issue={issues[f] ?? null} onChange={(v) => onChangeLot(l.mint, f, v)} />
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
      </Advanced>
    </section>
  );
}

/**
 * How long each lot of a live show runs: 45 s (the default, and what every show had before this choice), 90 s, 3 min or 5 min. Anti-sniping still
 * adds time for a late bid, up to the platform's cap, whatever the length. The server accepts the same range resolveRules clamps to (10 s to 1 h).
 */
function LotDurationChoice({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const t = useTranslations('sell');
  const locale = useLocale();
  const r = RULE_DEFAULTS;
  return (
    <fieldset className="sl-when" data-testid="lot-duration">
      <legend className="sl-h3">{t('wizard.duration.title')}</legend>
      <div className="sl-actions" role="group" aria-label={t('wizard.duration.title')}>
        {LOT_DURATION_PRESETS_S.map((s) => (
          <button key={s} type="button" className={`sl-btn${seconds === s ? ' sl-btn--primary' : ''}`} aria-pressed={seconds === s} data-testid={`lot-duration-${s}`} onClick={() => onChange(s)}>
            {formatDurationS(s, locale)}
          </button>
        ))}
      </div>
      <p className="sl-note" data-testid="lot-duration-hint">
        {t('wizard.duration.hint', { duration: formatDurationLong(seconds, locale), window: formatDurationLong(r.snipeWindowS, locale), max: formatDurationLong(r.maxExtensionS, locale) })}
      </p>
    </fieldset>
  );
}

/** Start now (default) or schedule. */
function WhenChoice({ state, now, onWhen, onStart }: { state: WizardState; now: Date; onWhen: (w: WhenMode) => void; onStart: (v: string) => void }) {
  const t = useTranslations('sell');
  const locale = useLocale();
  const issues = showIssues(state, now);
  const iso = localInputToIso(state.start);
  return (
    <fieldset className="sl-when">
      <legend className="sl-h3">{t('wizard.time.title')}</legend>
      {(['now', 'schedule'] as const).map((w) => (
        <label key={w} className={`sl-choice${state.when === w ? ' is-on' : ''}`}>
          <input type="radio" name="when" value={w} checked={state.when === w} data-testid={`time-${w}`} onChange={() => onWhen(w)} />
          <span><strong>{t(`wizard.time.${w}`)}</strong><small>{t(`wizard.time.${w}Hint`)}</small></span>
        </label>
      ))}
      {state.when === 'schedule' && (
        <label className="sl-field">
          <span>{t('wizard.time.start')}</span>
          <input type="datetime-local" value={state.start} aria-invalid={issues.start ? true : undefined} data-testid="show-start" onChange={(e) => onStart(e.target.value)} />
          <small className={issues.start ? 'sl-err' : 'sl-hint'} data-testid={issues.start ? 'start-issue' : undefined}>
            {issues.start ? t(`wizard.show.issues.start_${issues.start}`) : iso ? t('wizard.show.startShown', { when: formatWhen(iso, locale) }) : t('wizard.time.startEmpty')}
          </small>
        </label>
      )}
    </fieldset>
  );
}

function ReadyBadge({ r }: { r: Readiness | undefined }) {
  const t = useTranslations('sell');
  const kind = r?.kind ?? 'unchecked';
  return (
    <span className={`sl-badge sl-badge--${kind}`} data-testid="ready-badge" data-state={kind}>
      {kind === 'ready' ? t('wizard.publish.ready') : kind === 'checking' ? t('wizard.publish.checking') : kind === 'blocked' ? t('wizard.publish.blocked') : kind === 'error' ? t('wizard.publish.error') : t('wizard.publish.unchecked')}
    </span>
  );
}

function LotRow({ lot, r, locale }: { lot: LotDraft; r: Readiness | undefined; locale: string }) {
  const t = useTranslations('sell');
  const reasonText = useReasonText();
  const opening = parseUsdc(lot.opening);
  const reserve = lot.reserve.trim() === '' ? null : parseUsdc(lot.reserve);
  return (
    <li className="sl-row" data-testid="publish-lot" data-mint={lot.mint}>
      <div>
        <strong>{lot.name}</strong>
        <p className="sl-note">
          {t('wizard.publish.terms', {
            opening: opening.ok ? formatUsdc(opening.base, locale) : '',
            reserve: reserve?.ok ? formatUsdc(reserve.base, locale) : t('wizard.publish.noReserve'),
          })}
        </p>
        {r?.kind === 'blocked' && (
          <ul className="sl-why">
            {r.reasons.map((x) => <li key={x}>{reasonText(x)}</li>)}
          </ul>
        )}
      </div>
      <ReadyBadge r={r} />
    </li>
  );
}

/** Step 3: the time, the card check, one short paragraph about how the sale ends, and Publish. `state` carries the generated title when the seller typed none; `titleInput` is what they typed. The title field sits behind "Advanced options". */
export function TimeStep({
  state, now, autoTitle, titleInput, publishing, publishError, onWhen, onStart, onTitle, onCheck, onPublish, onDuration, onVideo, onLotDuration,
}: {
  state: WizardState; now: Date; autoTitle: string; titleInput: string; publishing: boolean; publishError: string | null;
  onWhen: (w: WhenMode) => void; onStart: (v: string) => void; onTitle: (v: string) => void; onCheck: () => void; onPublish: () => void;
  onDuration?: (next: { kind: ShowKind; durationS: number | null }) => void; onVideo?: (enabled: boolean) => void; onLotDuration?: (seconds: number) => void;
}) {
  const t = useTranslations('sell');
  const locale = useLocale();
  const checking = isChecking(state);
  const enabled = canPublish(state, now) && !publishing;
  const issues = showIssues(state, now);
  return (
    <section>
      <h2 className="sl-h2">{t('wizard.time.heading')}</h2>
      <DurationPicker kind={state.kind ?? 'live'} durationS={state.durationS ?? null} lotCount={state.lots.length} onChange={onDuration ?? (() => {})} />
      {state.kind !== 'timed' && <LotDurationChoice seconds={lotDurationOf(state)} onChange={onLotDuration ?? (() => {})} />}
      <WhenChoice state={state} now={now} onWhen={onWhen} onStart={onStart} />

      <h3 className="sl-h3">{t('wizard.publish.title')}</h3>
      <ul className="sl-rows">
        {state.lots.map((l) => <LotRow key={l.mint} lot={l} r={state.readiness[l.mint]} locale={locale} />)}
      </ul>
      <WalletPromptHint kind="consign" />
      <div className="sl-actions">
        <button type="button" className="sl-btn" data-testid="check-ready" disabled={checking || publishing} onClick={onCheck}>
          {checking ? t('wizard.publish.checkingBtn') : allReady(state) ? t('wizard.publish.recheck') : t('wizard.publish.check')}
        </button>
      </div>
      <p className="sl-note" data-testid="readiness-explain">{t('wizard.publish.explain')}</p>

      <div className="sl-terms" data-testid="contract-copy">
        <p>{t('wizard.publish.summary')}</p>
        <details className="sl-more" data-testid="learn-more">
          <summary>{t('wizard.publish.learnMore')}</summary>
          <ul>
            <li>{t('wizard.publish.ruleAuto')}</li>
            <li>{t('wizard.publish.ruleCosign')}</li>
            <li>{t('wizard.publish.ruleOnline')}</li>
            <li>{t('wizard.publish.ruleWithdraw')}</li>
            <li>{t('wizard.publish.ruleFee')}</li>
          </ul>
        </details>
      </div>

      <Advanced id="time" className="sl-adv" bodyClassName="sl-adv-body">
          <label className="sl-field">
            <span>{t('wizard.show.name')}</span>
            <input type="text" value={titleInput} maxLength={80} autoComplete="off" placeholder={autoTitle} aria-invalid={issues.title ? true : undefined} data-testid="show-title" onChange={(e) => onTitle(e.target.value)} />
            <small className={issues.title ? 'sl-err' : 'sl-hint'} data-testid={issues.title ? 'title-issue' : undefined}>
              {issues.title ? t(`wizard.show.issues.title_${issues.title}`) : t('wizard.show.nameHint')}
            </small>
          </label>
          <VideoOption enabled={state.videoEnabled === true} onChange={onVideo ?? (() => {})} />
      </Advanced>

      {publishError && <p className="sl-warn" role="alert" data-testid="publish-error">{publishError}</p>}
      <div className="sl-actions">
        <button type="button" className="sl-btn sl-btn--primary" data-testid="publish" disabled={!enabled} onClick={onPublish}>
          {publishing ? t('wizard.publish.publishing') : state.when === 'now' ? t('wizard.publish.buttonNow', { count: state.lots.length }) : t('wizard.publish.button', { count: state.lots.length })}
        </button>
        {!allReady(state) && !checking && <span className="sl-note" data-testid="publish-blocked-note">{t('wizard.publish.needReady')}</span>}
      </div>
    </section>
  );
}

export function Nav({ state, onBack, onNext }: { state: WizardState; onBack: () => void; onNext: () => void }) {
  const t = useTranslations('sell');
  return (
    <div className="sl-actions" data-tour="sell-nav">
      {state.step !== 'pick' && <button type="button" className="sl-btn" data-testid="wizard-back" onClick={onBack}>{t('wizard.back')}</button>}
      {state.step !== 'time' && (
        <button type="button" className="sl-btn sl-btn--primary" data-testid="wizard-next" disabled={!canLeave(state, state.step)} onClick={onNext}>
          {t('wizard.next')}
        </button>
      )}
    </div>
  );
}
