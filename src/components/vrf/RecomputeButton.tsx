'use client';

import type { VrfT } from './text';

/** "Recompute it yourself": runs all nine rules in this browser (the last four read the public network). */
export default function RecomputeButton({ running, done, onRun, t }: { running: boolean; done: boolean; onRun: () => void; t: VrfT }) {
  return (
    <div>
      <div className="vrf-row">
        <button type="button" className="vrf-btn" data-testid="vrf-recompute" onClick={onRun} disabled={running} aria-busy={running}>
          {running ? t('recompute.running') : t(done ? 'recompute.again' : 'recompute.button')}
        </button>
      </div>
      <p className="vrf-check-how">{t('recompute.hint')}</p>
    </div>
  );
}
