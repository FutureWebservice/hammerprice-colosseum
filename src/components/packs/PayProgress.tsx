'use client';

import type { PackDrawView } from '@/contracts';
import { PAY_STEPS, payStepOf, waitsForOperator } from './purchase';
import { usePackT } from './usePackT';

/**
 * The four steps of a pay-first purchase (pay, confirm, draw, deliver), with the one the purchase is in marked for assistive technology too.
 * Plain list, no motion: the status line next to it carries the words.
 */
export default function PayProgress({ draw }: { draw: PackDrawView }) {
  const t = usePackT();
  const at = payStepOf(draw.status, waitsForOperator(draw));
  const index = at === 'done' ? PAY_STEPS.length : PAY_STEPS.indexOf(at);
  return (
    <ol className="pk-progress" data-testid="pay-progress" data-step={at} aria-label={t('progress.title')}>
      {PAY_STEPS.map((s, i) => (
        <li key={s} data-state={i < index ? 'done' : i === index ? 'now' : 'todo'} aria-current={i === index && at !== 'done' ? 'step' : undefined}>
          {t(s === 'deliver' && draw.operator?.isHouse ? 'progress.demoEnd' : `progress.${s}`)}
        </li>
      ))}
    </ol>
  );
}
