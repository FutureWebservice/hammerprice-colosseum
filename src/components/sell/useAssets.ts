'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SellAsset } from '@/contracts/api';
import { getSellAssets, type ApiFail } from './api';

export type AssetsState =
  | { status: 'loading' }
  | { status: 'error'; error: ApiFail }
  | { status: 'ready'; assets: SellAsset[] };

/** The signed-in seller's cards from GET /api/sell/assets, with a reload that keeps the old list on screen while it runs. */
export function useAssets() {
  const [state, setState] = useState<AssetsState>({ status: 'loading' });
  const load = useCallback(async () => {
    const r = await getSellAssets();
    setState(r.ok ? { status: 'ready', assets: r.data.assets } : { status: 'error', error: r });
    return r;
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load };
}
