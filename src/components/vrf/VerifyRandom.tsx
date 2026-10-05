'use client';

/**
 * /verify/random/[id]: one draw, everything public about it, and the proof recomputed in THIS browser. The page never says "proven"
 * on our word: the verdict rests on the five cryptographic rules (lib/vrf verifyCrypto) running on this machine. While the draw is open the
 * page keeps it moving (POST advance, public and idempotent) and refreshes itself; the four chain rules run on the button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { Check, VrfRequestView } from '@/lib/vrf';
import '@/components/room/room.css';
import './vrf.css';
import VerifyHead from '@/components/verify/VerifyHead';
import StatePanel, { SP_ALT, SP_PRIMARY } from '@/components/ui/StatePanel';
import Checklist from './Checklist';
import KeyCard from './KeyCard';
import ProofPanel from './ProofPanel';
import RecomputeButton from './RecomputeButton';
import { fetchKey, type KeyInfo, fetchLotNames, fetchRequest, postAdvance, proofPackage, provenLocally, runAll, runCrypto, type Loaded } from './client';
import { useVrfT } from './text';

type Load = { kind: 'loading' } | Exclude<Loaded<never>, { kind: 'ok' }> | { kind: 'ready'; view: VrfRequestView };
const POLL_MS = 4000;

export default function VerifyRandom({ id, locale }: { id: string; locale: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [key, setKey] = useState<KeyInfo | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [proven, setProven] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [full, setFull] = useState(false);
  const view = load.kind === 'ready' ? load.view : null;
  const t = useVrfT(view?.cluster);
  const tl = useTranslations('vrf');
  const lastChecked = useRef<string>('');

  // Load the draw; while it is open, advance it and refresh. The loop stops when the draw is revealed or defaulted.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (first: boolean) => {
      const open = (v: VrfRequestView) => v.status === 'pending' || v.status === 'committed';
      const r = await (first ? fetchRequest(id) : postAdvance(id));
      if (!live) return;
      if (r.kind === 'ok') {
        setLoad({ kind: 'ready', view: r.value });
        if (open(r.value)) timer = setTimeout(() => void tick(false), POLL_MS);
        return;
      }
      if (first || r.kind !== 'error') { setLoad(r); return; }
      timer = setTimeout(() => void tick(false), POLL_MS); // a poll that failed: keep what is shown and try again
    };
    void tick(true);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [id]);

  useEffect(() => { void fetchKey().then((r) => { if (r.kind === 'ok') setKey(r.value); }); }, []);
  const showId = view?.subject.id;
  useEffect(() => { if (showId) void fetchLotNames(showId).then(setNames); }, [showId]);

  // The five cryptographic rules run by themselves as soon as the draw is final.
  useEffect(() => {
    if (!view || view.status === 'pending' || view.status === 'committed') { setChecks(null); setProven(null); return undefined; }
    const stamp = `${view.id}:${view.status}:${view.proofHex ?? ''}`;
    if (lastChecked.current === stamp) return undefined;
    lastChecked.current = stamp;
    let live = true;
    void runCrypto(view).then(async (c) => { if (live) { setChecks(c); setProven(view.status === 'revealed' && (await provenLocally(c))); setFull(false); } });
    return () => { live = false; };
  }, [view]);

  const recompute = useCallback(async () => {
    if (!view) return;
    setRunning(true);
    try {
      const c = await runAll(view);
      setChecks(c);
      setProven(view.status === 'revealed' && (await provenLocally(c)));
      setFull(true);
    } finally { setRunning(false); }
  }, [view]);

  const download = useCallback(() => {
    if (!view) return;
    const url = URL.createObjectURL(new Blob([proofPackage(view, checks)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `hammerprice-vrf-${view.id}.json`; a.click();
    URL.revokeObjectURL(url);
  }, [view, checks]);

  const failed = checks?.some((c) => c.status === 'fail') ?? false;
  const verdict = !view ? null
    : view.status === 'pending' ? { s: 'pending', tone: 'warn' }
    : view.status === 'committed' ? { s: 'committed', tone: 'warn' }
    : view.status === 'defaulted' ? { s: 'defaulted', tone: 'warn' }
    : failed ? { s: 'failed', tone: 'bad' }
    : checks === null || proven === null ? { s: 'checking', tone: 'warn' }
    : proven ? { s: 'proven', tone: 'ok' } : { s: 'failed', tone: 'bad' };

  const raffle = view?.purpose === 'raffle';
  return (
    <div className="hp hp-verify vrf" data-testid="vrf-page">
      <VerifyHead kicker={tl('page.kicker')} title={tl(raffle ? 'page.titleRaffle' : 'page.title')} lede={tl(raffle ? 'page.ledeRaffle' : 'page.lede')} />
      {load.kind === 'loading' && <p role="status">{tl('page.loading')}</p>}
      {(load.kind === 'not_found' || load.kind === 'off' || load.kind === 'error') && (
        <StatePanel variant="compact" role="alert" testId={load.kind === 'not_found' ? 'vrf-missing' : load.kind === 'off' ? 'vrf-off' : 'vrf-error'}
          kicker={tl('page.missingKicker')} title={tl(load.kind === 'not_found' ? 'page.notFound' : load.kind === 'off' ? 'page.off' : 'page.unavailable')} actions={<>
          <Link href={`/${locale}/rooms`} className={SP_PRIMARY}>{tl('page.rooms')}</Link>
          <Link href={`/${locale}`} className={SP_ALT}>{tl('page.home')}</Link>
        </>} />
      )}
      {view && verdict && (
        <>
          <p role="status" className={`vrf-verdict is-${verdict.tone}`} data-testid="vrf-verdict" data-state={verdict.s}>{t(`verdict.${verdict.s}`)}</p>
          <ProofPanel view={view} names={names} t={t} />
          {(view.status === 'revealed' || view.status === 'defaulted') && (
            <>
              <h2>{tl('recompute.button')}</h2>
              <RecomputeButton running={running} done={full} onRun={() => void recompute()} t={t} />
              {checks && <Checklist checks={checks} t={t} />}
              {full && <p className="vrf-check-how">{t('verdict.chainNote')}</p>}
              <div className="vrf-row"><button type="button" className="vrf-btn is-small" data-testid="vrf-download" onClick={download}>{tl('fields.download')}</button></div>
            </>
          )}
          <KeyCard publicKey={view.publicKey} cluster={view.cluster} info={key} t={t} />
          <h2>{tl('explain.title')}</h2>
          <p data-testid="vrf-explain-proven">{t('explain.proven')}</p>
          <p data-testid="vrf-explain-not">{t('explain.notProven')}</p>
          <p data-testid="vrf-explain-beacon">{t('explain.beacon')}</p>
          <p><Link className="hp-inline-link" href={`/${locale}/room/${view.subject.id}`}>{tl('page.back')}</Link></p>
        </>
      )}
    </div>
  );
}
