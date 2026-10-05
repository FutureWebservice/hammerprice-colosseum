'use client';

/** One line under the phase strip: what to do next. The decision is nextStep() (pure); this only draws its sentence. */
import type { Cluster } from '@/contracts';
import { useClusterT } from '@/lib/client/cluster-text';
import { nextStep, type NextStepState } from '@/lib/client/next-step';
import './ux.css';

export default function NextStepLine({ state, cluster }: { state: NextStepState; cluster?: Cluster }) {
  const t = useClusterT('tour', cluster);
  const key = nextStep(state);
  return (
    <p className="ux-next" role="status" aria-live="polite" data-testid="next-step" data-step={key}>
      <span className="ux-next-label">{t('nextStep.label')}</span>
      <span className="ux-next-text">{t(`nextStep.${key}`)}</span>
    </p>
  );
}
