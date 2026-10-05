'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useWallet } from '@solana/wallet-adapter-react';
import type { Transaction } from '@solana/web3.js';
import type { Cluster } from '@/contracts';
import FaucetButton from '@/components/account/FaucetButton';
import { buyCreditPack, type BuyStep } from './buy';

/** One button: quote, check, wallet, pay, wait. Needs the wallet adapter; shows each step and a plain reason when it fails. */
export default function BuyCredits({ cluster, onBought, disabled }: { cluster: Cluster; onBought: (balance: number, explorerUrl?: string) => void; disabled?: boolean }) {
  const t = useTranslations('ai.credits');
  const { publicKey, signTransaction } = useWallet();
  const [step, setStep] = useState<BuyStep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wallet = publicKey?.toBase58() ?? null;

  if (!wallet || !signTransaction) return <p className="ai-note" data-testid="ai-buy-needwallet">{t('needWallet')}</p>;

  async function buy() {
    setErr(null);
    const r = await buyCreditPack({ wallet: wallet!, cluster, signTransaction: signTransaction as (tx: Transaction) => Promise<Transaction>, onStep: setStep });
    setStep(null);
    if (r.ok) onBought(r.balance, r.explorerUrl);
    else setErr(r.key.replace(/^credits\./, ''));
  }

  return (
    <div className="ai-buy">
      <button type="button" className="ai-btn ai-btn--primary" onClick={() => void buy()} disabled={disabled || step !== null} data-testid="ai-buy">{t('buy')}</button>
      {step && <p className="ai-note" role="status" data-testid="ai-buy-step">{t(`step.${step}`)}</p>}
      <BuyError err={err} cluster={cluster} onFunded={() => setErr(null)} />
    </div>
  );
}

/** The reason a purchase failed. On devnet, "not enough USDC" comes with the test faucet; after a claim the message goes and the buy button is ready again. */
export function BuyError({ err, cluster, onFunded }: { err: string | null; cluster: Cluster; onFunded: () => void }) {
  const t = useTranslations('ai.credits');
  if (!err) return null;
  return (
    <>
      <p className="ai-err" role="alert" data-testid="ai-buy-error">{t(err)}</p>
      {err === 'insufficient' && cluster === 'devnet' && <FaucetButton onDone={onFunded} />}
    </>
  );
}
