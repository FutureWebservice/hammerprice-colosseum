'use client';

/**
 * Drives the purchase of one pack for the buyer: open (the 18+ confirmation, the seed), review what the wallet is asked to sign from the
 * transaction bytes, sign once, post the signature. Two flows:
 *  - chance pack (PAY FIRST): the payment carries no card. After it is sent the screen FOLLOWS the purchase (confirming, drawing, delivering) until the
 *    card is delivered (the reveal then plays) or the payment was returned.
 *  - equal-value pack: wait (for a third-party operator, or for the transaction to land) until the draw is settled and the card can be shown.
 * A round that runs out unsigned is `lapsed` (nothing was charged): one press continues. A reload during a purchase finds it again (sessionStorage keeps
 * the draw id per pack, per tab).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { VersionedTransaction } from '@solana/web3.js';
import type { PackView } from '@/contracts';
import { classifyWalletError } from '@/lib/client/bidder';
import { SettleError } from '@/lib/client/settle';
import { browserStore, readFlag, writeFlag } from '@/lib/client/safe-storage';
import { isPayFirstPayment, signPackPayment } from '@/lib/packs/client';
import { getDraw, openPack, signDraw } from './api';
import { newClientSeed, stateAfterFollow, stateAfterPoll, waitsForOperator, type PurchaseState } from './purchase';

const POLL_MS = 2000;
const SLOW_POLL_MS = 15_000;
export const drawKey = (packId: string) => `hp.pack.draw.${packId}`;
export const shownKey = (drawId: string) => `hp.pack.shown.${drawId}`;

export function usePackPurchase(pack: PackView, o: { cluster: string | null }) {
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [state, setState] = useState<PurchaseState>({ kind: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const run = useRef(0);

  const set = useCallback((s: PurchaseState) => { stateRef.current = s; setState(s); }, []);

  const start = useCallback(async () => {
    if (!wallet) return;
    if (!signTransaction) { set({ kind: 'error', code: 'wallet', wallet: 'unsupported' }); return; }
    const mine = ++run.current;
    const live = () => run.current === mine;
    set({ kind: 'working', stage: pack.mode === 'chance' ? 'preparing' : 'drawing' }); // a chance pack draws nothing yet: only the payment is prepared
    const opened = await openPack(pack.id, { clientSeed: newClientSeed(), ageConfirmed: true });
    if (!live()) return;
    if (!opened.ok) { set({ kind: 'error', code: opened.code, retryAfterS: opened.retryAfterS }); return; }
    const { draw, payment } = opened.data;
    writeFlag(browserStore('session'), drawKey(pack.id), draw.id);
    set({ kind: 'wallet', draw, payment, review: null });
    let signed: string;
    try {
      ({ signedTxBase64: signed } = await signPackPayment(payment, {
        role: 'buyer', myWallet: wallet, cluster: o.cluster, agreedGross: pack.price,
        signTransaction: (tx: VersionedTransaction) => signTransaction(tx),
        onReviewed: (review) => { if (live() && stateRef.current.kind === 'wallet') set({ kind: 'wallet', draw, payment, review }); },
      }));
    } catch (e) {
      if (!live()) return;
      if (e instanceof SettleError) set({ kind: 'error', code: e.kind === 'wallet' ? 'wallet' : e.kind, wallet: e.kind === 'wallet' ? classifyWalletError(e.detail?.cause) : undefined });
      else set({ kind: 'error', code: 'generic' });
      return;
    }
    if (!live()) return;
    set({ kind: 'working', stage: 'preparing' });
    const res = await signDraw(draw.id, { role: 'buyer', signedTxBase64: signed });
    if (!live()) return;
    if (!res.ok) {
      if (res.code === 'round_expired' || res.code === 'blockhash_expired') set({ kind: 'lapsed', draw });
      else set({ kind: 'error', code: res.code });
      return;
    }
    const next = res.data.draw;
    if (res.data.step === 'settled' || next.status === 'settled' || next.status === 'demo_revealed') set({ kind: 'settled', draw: next });
    else if (isPayFirstPayment(payment.expected) || next.flow === 'pay_first') set(stateAfterFollow(next));
    else set({ kind: 'waiting', draw: next, on: payment.operatorSigned ? 'chain' : 'operator', roundExpiresAt: payment.roundExpiresAt });
  }, [wallet, signTransaction, pack.id, pack.price, pack.mode, o.cluster, set]);

  // Waiting: poll the draw until it settles, ends or its round runs out.
  const waitingId = state.kind === 'waiting' ? state.draw.id : null;
  useEffect(() => {
    if (!waitingId) return undefined;
    let stopped = false;
    const tick = async () => {
      const r = await getDraw(waitingId);
      if (stopped || !r.ok) return;
      const cur = stateRef.current;
      if (cur.kind === 'waiting') set(stateAfterPoll(r.data, cur, Date.now()));
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [waitingId, set]);

  // Following a pay-first purchase: poll the draw (a read carries it forward on the server) until it is delivered, not delivered or ended.
  const followingId = state.kind === 'following' ? state.draw.id : null;
  const slow = state.kind === 'following' && waitsForOperator(state.draw); // the operator has a day: no need to ask every two seconds
  useEffect(() => {
    if (!followingId) return undefined;
    let stopped = false;
    const tick = async () => {
      const r = await getDraw(followingId);
      if (stopped || !r.ok) return;
      if (stateRef.current.kind === 'following') set(stateAfterFollow(r.data));
    };
    void tick();
    const id = setInterval(() => void tick(), slow ? SLOW_POLL_MS : POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [followingId, slow, set]);

  // A reload in the middle of a purchase: find the draw again.
  useEffect(() => {
    const store = browserStore('session');
    const id = readFlag(store, drawKey(pack.id));
    if (!id || !wallet) return undefined;
    let stopped = false;
    void getDraw(id).then((r) => {
      if (stopped || stateRef.current.kind !== 'idle') return;
      if (!r.ok) { writeFlag(store, drawKey(pack.id), ''); return; }
      const d = r.data;
      if (d.buyer !== wallet) return;
      if ((d.status === 'settled' || d.status === 'demo_revealed') && readFlag(store, shownKey(d.id)) !== '1') set({ kind: 'settled', draw: d });
      else if (d.status === 'undelivered' && readFlag(store, shownKey(d.id)) !== '1') set({ kind: 'undelivered', draw: d });
      else if (d.status === 'reserved' || d.status === 'awaiting_payment') set({ kind: 'lapsed', draw: d });
      else if (d.flow === 'pay_first' && ['confirming', 'paid', 'drawn', 'delivering'].includes(d.status)) set({ kind: 'following', draw: d });
      else if (d.status === 'submitted') set({ kind: 'waiting', draw: d, on: 'chain', roundExpiresAt: null });
    });
    return () => { stopped = true; };
  }, [pack.id, wallet, set]);

  const reset = useCallback(() => { run.current++; set({ kind: 'idle' }); }, [set]);
  const markShown = useCallback((drawId: string) => { writeFlag(browserStore('session'), shownKey(drawId), '1'); }, []);
  return { state, start, reset, markShown, wallet };
}
