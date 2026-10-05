'use client';
// Devnet only: "Get test USDC" next to a "not enough USDC" message, so the person can fill the wallet right where it ran short.
// The caller renders it only on devnet and passes `onDone` to re-read the balance (or to retry). Texts: room.ready.funds.*.
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { clientCluster } from '@/lib/client/cluster-text';
import { claimFaucet } from './api';

/** The test-USDC faucet exists on devnet only: callers show the button behind this check. */
export const faucetAvailable = (): boolean => clientCluster() === 'devnet';

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done' } | { kind: 'fail'; code: string };

export default function FaucetButton({ onDone, className }: { onDone?: () => void; className?: string }) {
  const t = useTranslations('room');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const claim = useCallback(async () => {
    setState({ kind: 'busy' });
    const r = await claimFaucet();
    if (r.ok) { setState({ kind: 'done' }); onDone?.(); } else setState({ kind: 'fail', code: r.code });
  }, [onDone]);

  return (
    <span className={className} data-testid="faucet-button">
      <button type="button" className="hp-sheet-primary" data-testid="faucet-claim" disabled={state.kind === 'busy'} onClick={() => void claim()}>
        {state.kind === 'busy' ? t('ready.funds.claiming') : t('ready.funds.claim')}
      </button>
      {state.kind === 'fail' && (
        <span className="hp-sheet-error" role="alert" data-testid="faucet-error">
          {t(state.code === 'rate_limited' ? 'ready.funds.limited' : state.code === 'faucet_paused' ? 'ready.funds.paused' : 'ready.funds.failed')}
        </span>
      )}
    </span>
  );
}
