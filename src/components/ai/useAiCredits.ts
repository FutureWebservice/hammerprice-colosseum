'use client';

import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import type { AiCreditsResponse } from '@/contracts';
import { AiCallError, fetchCredits } from './client';

export type Credits = z.infer<typeof AiCreditsResponse>;
export type AiCreditsState =
  | { status: 'loading' }
  /** FEATURE_AI is off here: nothing of the AI feature is shown. */
  | { status: 'off' }
  | { status: 'signedout' }
  | { status: 'error' }
  | { status: 'ready'; credits: Credits };

/** The signed-in seller's credits. The first answer also tells whether the feature exists at all (404 = off). */
export function useAiCredits(): { state: AiCreditsState; refresh: () => Promise<void> } {
  const [state, setState] = useState<AiCreditsState>({ status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', credits: await fetchCredits() });
    } catch (e) {
      const code = e instanceof AiCallError ? e.code : '';
      setState({ status: code === 'feature_off' ? 'off' : code === 'unauthenticated' || code === 'banned' ? 'signedout' : 'error' });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state, refresh };
}

let healthFlag: Promise<boolean> | null = null;
/** Whether FEATURE_AI is effectively on, from the public health route (no session needed). One request per page load. */
export function useAiFeatureOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    healthFlag ??= fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((j: { flags?: Record<string, boolean> }) => j?.flags?.ai === true).catch(() => false);
    void healthFlag.then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, []);
  return on;
}
/** Tests only. */
export const resetHealthFlag = (): void => { healthFlag = null; };
