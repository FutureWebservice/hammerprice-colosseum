'use client';

/**
 * The result of a paid opening: the animated reveal, the card, its rarity and chance, links to the payment and the proof, and the proof check
 * run in this browser (the card must follow from the committed pool, the seed and the beacon; "checked" is shown only after that passed).
 */
import { useEffect, useRef, useState } from 'react';
import type { PackDrawView, PackView } from '@/contracts';
import { chainTarget } from '@/lib/verify/chain';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { normalizeCluster } from '@/lib/auth/config';
import { Link } from '@/lib/i18n';
import '../ui/hpx.css';
import { fetchProofBundle } from '@/lib/packs/client';
import { formatBps, rarityOf } from '@/lib/packs/rarity';
import PackNotice from './PackNotice';
import RevealStage from './RevealStage';
import { createSfx, type Sfx } from './sound';
import { usePackT } from './usePackT';

const DEPLOYMENT = {
  cluster: normalizeCluster(process.env.NEXT_PUBLIC_SOLANA_NETWORK),
  rpcPublic: process.env.NEXT_PUBLIC_SOLANA_RPC_PUBLIC,
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT,
};

type Check = 'checking' | 'ok' | 'bad';

export default function Revealed({ draw, pack, locale, onAnother, onShown }: { draw: PackDrawView; pack: PackView; locale: 'de' | 'en'; onAnother: () => void; onShown?: (drawId: string) => void }) {
  const t = usePackT();
  const look = rarityOf(pack.odds);
  const card = draw.card;
  const tier = pack.odds.find((o) => o.tier === (draw.tier ?? card?.tier));
  const rarity = look[draw.tier ?? card?.tier ?? ''] ?? 'common';
  const [sound, setSound] = useState(false);
  const sfx = useRef<Sfx | null>(null);
  const [check, setCheck] = useState<Check>('checking');
  const [arrived, setArrived] = useState(false);

  // Sound is created only when the visitor switches it on (a click), never before.
  const toggleSound = (on: boolean) => {
    setSound(on);
    if (on) sfx.current = sfx.current ?? createSfx();
    else { sfx.current?.close(); sfx.current = null; }
  };
  useEffect(() => () => { sfx.current?.close(); }, []);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const bundle = await fetchProofBundle(draw.id);
        if (!bundle) { if (!stopped) setCheck('bad'); return; }
        const [{ verifyPackDraw, isPackProven }, { createFetchRpc }] = await Promise.all([import('@/lib/packs/verify'), import('@/lib/vrf/rpc')]);
        const target = chainTarget(bundle.draw.cluster, DEPLOYMENT);
        const checks = await verifyPackDraw(bundle.pool, bundle.proofDraw, { earlier: bundle.earlier, rpc: createFetchRpc(target.rpcUrl) });
        if (!stopped) setCheck(isPackProven(checks) && !checks.some((c) => c.status === 'fail') ? 'ok' : 'bad');
      } catch {
        if (!stopped) setCheck('bad');
      }
    })();
    return () => { stopped = true; };
  }, [draw.id]);

  if (!card) return null;
  const demo = draw.status === 'demo_revealed'; // the devnet demo: a copy of the drawn card is minted into the buyer's wallet (its transaction is `deliverySignature`)
  const tierName = tier?.label[locale] ?? t(`tier.${rarity}`);
  return (
    <div className="pk-reveal" data-testid="revealed" data-rarity={rarity}>
      <RevealStage
        card={{ name: card.name, imageUrl: card.imageUrl }}
        rarity={rarity}
        odds={pack.odds}
        count={pack.pool.total}
        packName={pack.name[locale]}
        packSeed={pack.id}
        houseTag={pack.operator.isHouse ? t('tile.houseTag') : undefined}
        sfx={sound ? sfx.current : null}
        labels={{ sealed: t('reveal.sealed'), tearing: t('reveal.tearing'), shown: t('reveal.shown'), skip: t('reveal.skip') }}
        onShown={() => { setArrived(true); onShown?.(draw.id); }}
      />
      <div className="pk-result" style={arrived ? undefined : { visibility: 'hidden' }} aria-hidden={arrived ? undefined : true}>
        <h3 data-testid="reveal-title">{t(demo ? 'reveal.drawnDemo' : 'reveal.received', { name: card.name })}</h3>
        <div className="pk-result-meta">
          {card.grade && <span className="pk-note" style={{ margin: 0 }} data-testid="reveal-grade">{t('reveal.grade', { grade: card.grade })}</span>}
          <span className="pk-chip" data-rarity={rarity}>{tier ? t('reveal.tierOdds', { tier: tierName, chance: formatBps(tier.bps, locale) }) : tierName}</span>
          <span className={`pk-verify${check === 'ok' ? ' pk-verify--ok' : ''}`} data-testid="verify-badge" data-check={check}>
            {check === 'checking' ? t('reveal.verifying') : check === 'ok' ? t('reveal.verified') : t('reveal.notVerified')}
          </span>
        </div>
        {demo && <p className="pk-result-status" data-testid="demo-outcome" role="note">{t(draw.deliverySignature ? 'demo.minted' : 'demo.status')}</p>}
        <div className="pk-result-actions">
          <button type="button" className="hpx-btn" onClick={onAnother} data-testid="open-another">{t(demo ? 'reveal.anotherDemo' : 'reveal.another')}</button>
          {demo && <Link href="/packs#real-packs" className="hpx-btn hpx-btn--ghost" data-testid="demo-browse">{t('demo.browse')}</Link>}
          {demo && <Link href="/packs/manage" className="hpx-btn hpx-btn--ghost" data-testid="demo-offer-pack">{t('demo.offer')}</Link>}
        </div>
        <div className="pk-result-links">
          {draw.txSignature && <a className="pk-link" href={explorerTxUrl(draw.txSignature, draw.cluster)} target="_blank" rel="noopener noreferrer">{t('reveal.viewTx')}</a>}
          {draw.deliverySignature && <a className="pk-link" href={explorerTxUrl(draw.deliverySignature, draw.cluster)} target="_blank" rel="noopener noreferrer" data-testid="view-delivery">{t(demo ? 'reveal.viewMint' : 'reveal.viewDelivery')}</a>}
          <Link className="pk-link" href={`/verify/packs/${draw.id}`}>{t('reveal.viewProof')}</Link>
          <label className="pk-toggle" title={t('reveal.soundLabel')}>
            <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} data-testid="sound-toggle" />
            <span>{sound ? t('reveal.soundOn') : t('reveal.soundOff')}</span>
          </label>
        </div>
        <PackNotice pack={pack} />
      </div>
    </div>
  );
}
