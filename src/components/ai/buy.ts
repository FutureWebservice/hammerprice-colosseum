/**
 * The purchase flow of one credit pack in the browser: quote, check the transaction bytes against what the build knows, let the wallet sign,
 * check that the wallet did not change the message, pay, wait for the chain. `signTransaction` is injected (the wallet adapter), so the flow is
 * tested without a wallet. Nothing is posted unless every check passed; a refusal in the wallet posts nothing and costs nothing.
 */
import { Transaction } from '@solana/web3.js';
import type { Cluster } from '@/contracts';
import { assertCreditTx } from '@/lib/chain/credit-tx';
import { AiCallError, errorKey, fetchPurchase, fetchQuote, postPay } from './client';
import { expectedFromQuote, pinnedFromBuild, QuoteRefused, type Pinned } from './expected';

export type BuyStep = 'quote' | 'check' | 'sign' | 'send' | 'wait';
export type BuyResult = { ok: true; balance: number; txSignature?: string; explorerUrl?: string } | { ok: false; key: string };

export interface BuyDeps {
  wallet: string;
  cluster: Cluster;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  onStep: (s: BuyStep) => void;
  pinned?: Pinned;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the chain after the payment was sent. */
  waitMs?: number;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function buyCreditPack(d: BuyDeps): Promise<BuyResult> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    d.onStep('quote');
    const q = await fetchQuote();
    d.onStep('check');
    const expected = expectedFromQuote(q, { wallet: d.wallet, cluster: d.cluster, pinned: d.pinned ?? pinnedFromBuild() });
    const bytes = unb64(q.txBase64);
    assertCreditTx(bytes, expected); // wallet guard instructions are tolerated here, nothing else
    d.onStep('sign');
    let signed: Transaction;
    try {
      signed = await d.signTransaction(Transaction.from(bytes));
    } catch {
      return { ok: false, key: 'credits.rejected' };
    }
    const signedBytes = signed.serialize({ requireAllSignatures: false, verifySignatures: false });
    assertCreditTx(signedBytes, expected, { tolerated: [] }); // the wallet must not have changed the message
    d.onStep('send');
    let view = await postPay(q.purchaseId, b64(signedBytes));
    d.onStep('wait');
    const deadline = Date.now() + (d.waitMs ?? 40_000);
    while (view.status === 'submitted' && Date.now() < deadline) {
      await sleep(1500);
      view = await fetchPurchase(q.purchaseId);
    }
    if (view.status === 'settled') return { ok: true, balance: view.balance, txSignature: view.txSignature, explorerUrl: view.explorerUrl };
    return { ok: false, key: view.status === 'expired' ? 'credits.expired' : 'credits.failed' };
  } catch (e) {
    if (e instanceof QuoteRefused) return { ok: false, key: 'credits.mismatch' };
    if (e instanceof AiCallError) return { ok: false, key: errorKey(e, 'credits') };
    if ((e as { code?: string })?.code === 'tx_mismatch') return { ok: false, key: 'credits.mismatch' };
    return { ok: false, key: 'credits.failed' };
  }
}
