'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { ShowKind } from '@/contracts/common';
import { TIMED_RULE_DEFAULTS } from '@/lib/auction/rules';
import { formatDurationLong, formatDurationS } from '@/lib/auction/time-format';

/**
 * Slot: live show or timed auction, and how long a timed one stays open (owner: TIMED, FEATURE_TIMED). Mounted by TimeStep above the start choice.
 * It is a collapsed "advanced" block, so the default flow is unchanged: the seller who opens it can switch to a timed auction (one card, 1 h, 6 h,
 * 24 h, 3 d or 7 d). It renders nothing while the feature is off (it asks GET /api/health once for the switch), so the wizard keeps creating live
 * shows exactly as before.
 */
export interface DurationPickerProps {
  kind: ShowKind;
  /** Seconds a timed lot runs; null = the show kind's default. */
  durationS: number | null;
  lotCount: number;
  onChange: (next: { kind: ShowKind; durationS: number | null }) => void;
}

export const DURATION_PRESETS_S = [3600, 6 * 3600, 86_400, 3 * 86_400, 7 * 86_400] as const;
export const DEFAULT_TIMED_DURATION_S = 86_400;

type Pick = { kind: ShowKind; durationS: number | null };
export const chooseLive = (): Pick => ({ kind: 'live', durationS: null });
/** Switching to timed keeps a length the seller already picked, else the default of one day. */
export const chooseTimed = (previous: number | null): Pick => ({ kind: 'timed', durationS: previous ?? DEFAULT_TIMED_DURATION_S });
export const chooseDuration = (s: number): Pick => ({ kind: 'timed', durationS: s });

/** Is FEATURE_TIMED on (environment and kill switch)? One request per page load; any failure reads as "off". */
let probe: Promise<boolean> | null = null;
export function timedFeatureOn(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  probe ??= fetchImpl('/api/health', { cache: 'no-store' })
    .then((r) => r.json() as Promise<{ flags?: Record<string, unknown> }>)
    .then((j) => j?.flags?.timed === true)
    .catch(() => { probe = null; return false; });
  return probe;
}
/** Tests only. */
export const resetTimedProbe = (): void => { probe = null; };

export function DurationPickerView({ kind, durationS, lotCount, onChange }: DurationPickerProps) {
  const t = useTranslations('timed');
  const locale = useLocale();
  const timed = kind === 'timed';
  const chosen = durationS ?? DEFAULT_TIMED_DURATION_S;
  const r = TIMED_RULE_DEFAULTS;
  return (
    <details className="sl-adv" data-testid="advanced-timed" open={timed || undefined}>
      <summary>{t('picker.summary')}</summary>
      <div className="sl-adv-body">
        <fieldset className="sl-when">
          <legend className="sl-note">{t('picker.legend')}</legend>
          {(['live', 'timed'] as const).map((k) => (
            <label key={k} className={`sl-choice${kind === k ? ' is-on' : ''}`}>
              <input type="radio" name="auction-kind" value={k} checked={kind === k} data-testid={`kind-${k}`} onChange={() => onChange(k === 'live' ? chooseLive() : chooseTimed(durationS))} />
              <span><strong>{t(`picker.${k}`)}</strong><small>{t(`picker.${k}Hint`)}</small></span>
            </label>
          ))}
        </fieldset>
        {timed && (
          <div data-testid="timed-options">
            <p className="sl-note" id="timed-duration-label">{t('picker.duration')}</p>
            <div className="sl-actions" role="group" aria-labelledby="timed-duration-label">
              {DURATION_PRESETS_S.map((s) => (
                <button key={s} type="button" className={`sl-btn${chosen === s ? ' sl-btn--primary' : ''}`} aria-pressed={chosen === s} data-testid={`duration-${s}`} onClick={() => onChange(chooseDuration(s))}>
                  {formatDurationS(s, locale)}
                </button>
              ))}
            </div>
            {lotCount !== 1 && <p className="sl-warn" role="alert" data-testid="timed-one-card">{t('picker.oneCard', { count: lotCount })}</p>}
            <p className="sl-note" data-testid="timed-rules">{t('picker.rules', { window: formatDurationLong(r.snipeWindowS, locale), extend: formatDurationLong(r.snipeExtendS, locale), max: formatDurationLong(r.maxExtensionS, locale) })}</p>
            <p className="sl-note" data-testid="timed-settle">{t('picker.settle', { time: formatDurationLong(r.settlementWindowS, locale) })}</p>
            <p className="sl-note" data-testid="timed-limit">{t('picker.limit')}</p>
          </div>
        )}
      </div>
    </details>
  );
}

export default function DurationPicker(props: DurationPickerProps) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let dead = false;
    void timedFeatureOn().then((v) => { if (!dead) setOn(v); });
    return () => { dead = true; };
  }, []);
  // A timed pick that is already in the wizard state stays editable even if the probe has not answered (or failed).
  if (!on && props.kind !== 'timed') return null;
  return <DurationPickerView {...props} />;
}
