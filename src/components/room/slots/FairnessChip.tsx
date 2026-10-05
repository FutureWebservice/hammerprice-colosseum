'use client';

/**
 * Slot: the "order drawn by a verifiable random function" chip in the catalogue rail (owner: VRF, FEATURE_VRF). Mounted by CatalogueRail.tsx
 * under the catalogue heading. It renders nothing for a catalogue show.
 *
 * States: the order is being drawn (about 45 s; the chip keeps the draw moving by asking the server to advance it, public and idempotent),
 * "drawn by a random proof, checked in your browser" (green mark, only after the five cryptographic rules ran HERE and passed, link to the
 * proof page), a failed check (red cross), and the catalogue order when the draw was not completed in time. The tick is a local result,
 * never our claim.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import type { ShowOrder } from '@/contracts/vrf';
import { fetchRequest, postAdvance, provenLocally, runCrypto } from '@/components/vrf/client';
import { useVrfT } from '@/components/vrf/text';
import '@/components/vrf/vrf.css';

export interface FairnessChipProps {
  showId: string;
  /** `show.order` from the live snapshot: the mode and, for a drawn order, the request status and id. */
  order: ShowOrder;
}

type Local = 'checking' | 'verified' | 'failed';
const ADVANCE_MS = 5000;

/** A catalogue show (or a drawn order without a request) shows nothing, and mounts nothing: the hooks below only run for a drawn order. */
export default function FairnessChip(props: FairnessChipProps) {
  if (props.order.mode !== 'vrf' || !props.order.requestId || !props.order.status) return null;
  return <Chip {...props} />;
}

function Chip({ showId, order }: FairnessChipProps) {
  const t = useVrfT();
  const locale = useLocale();
  const requestId = order.requestId;
  const status = order.status;
  const [local, setLocal] = useState<Local>('checking');
  const checkedFor = useRef('');

  // While the draw is open every viewer nudges it along (a lease on the server makes parallel callers harmless).
  useEffect(() => {
    if (order.mode !== 'vrf' || !requestId || (status !== 'pending' && status !== 'committed')) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const nudge = async () => { await postAdvance(requestId); if (live) timer = setTimeout(() => void nudge(), ADVANCE_MS + Math.random() * 1500); };
    timer = setTimeout(() => void nudge(), 800 + Math.random() * 1500);
    return () => { live = false; clearTimeout(timer); };
  }, [order.mode, requestId, status]);

  // Once revealed, recompute in this browser.
  useEffect(() => {
    if (order.mode !== 'vrf' || !requestId || status !== 'revealed' || checkedFor.current === requestId) return undefined;
    checkedFor.current = requestId;
    let live = true;
    void (async () => {
      const r = await fetchRequest(requestId);
      if (!live) return;
      if (r.kind !== 'ok') { checkedFor.current = ''; return; } // try again on the next snapshot
      const ok = r.value.status === 'revealed' && (await provenLocally(await runCrypto(r.value)));
      if (live) setLocal(ok ? 'verified' : 'failed');
    })();
    return () => { live = false; };
  }, [order.mode, requestId, status]);

  if (!status) return null;
  const state = status === 'defaulted' ? 'defaulted' : status === 'revealed' ? (local === 'checking' ? 'checking' : local) : 'pending';
  const mark = state === 'verified' ? '✓' : state === 'failed' ? '✗' : '';
  const href = `/${locale}/verify/random/${requestId}`;
  return (
    <div className="vrf-chip" data-testid="fairness-chip" data-state={state} data-show={showId} role="status">
      <span className="vrf-chip-text" data-mark={mark}>
        {state === 'pending' && <span className="vrf-chip-dot" aria-hidden="true" />}
        {t(`chip.${state}`)}
      </span>
      {state !== 'pending' && <Link href={href} data-testid="fairness-link">{t('chip.details')}</Link>}
    </div>
  );
}
