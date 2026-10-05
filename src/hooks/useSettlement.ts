'use client';

/**
 * One settlement, seen by the buyer or the seller: polls GET /api/settlements/:id (2 s while a round is open),
 * and runs the signing round (prepare, review decoded bytes, assertSettlementTx, wallet signs, POST sign).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { VersionedTransaction } from '@solana/web3.js';
import { PreparedSettlement, SettlementView, SignResult } from '@/contracts';
import { classifyWalletError, readFailure, type ApiFailure, type WalletFailure } from '@/lib/client/bidder';
import { payStep, roundState, settlementDelayMs, signRound, SettleError, type ReviewedSettlement, type ReviewProblem, type PayStep, type RoundState } from '@/lib/client/settle';
import { assertSettlementTx } from './room/chainPort';

export interface SettleFailure { kind: SettleError['kind'] | 'load'; problems?: ReviewProblem[]; code?: unknown; wallet?: WalletFailure }

class ApiProblem extends Error { constructor(readonly failure: ApiFailure) { super('api'); } }

async function postJson<T>(url: string, body: unknown, parse: (v: unknown) => { success: boolean; data?: T }): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiProblem(await readFailure(res));
  const parsed = parse(await res.json().catch(() => null));
  if (!parsed.success) throw new ApiProblem({ code: 'shape', status: res.status });
  return parsed.data as T;
}

export function useSettlement(settlementId: string | null, o: { cluster: string | null; agreedGross: string | null; nowMs: () => number }) {
  const { publicKey, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [view, setView] = useState<SettlementView | null>(null);
  const [review, setReview] = useState<ReviewedSettlement | null>(null);
  const [failure, setFailure] = useState<SettleFailure | null>(null);
  // 'preparing' until the server has opened the round, then 'wallet' while the wallet prompt is open; null when nothing is running.
  const [stage, setStage] = useState<'preparing' | 'wallet' | null>(null);
  const [asked, setAsked] = useState(false);
  const run = useRef(0);
  const busy = stage !== null;
  const viewRef = useRef<SettlementView | null>(null);
  viewRef.current = view;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  // The round this party already signed: a poll that was in flight while the signature was posted can bring back a view from just before it
  // (buyer not signed, round open), and the sheet would ask the wallet a second time. Not blocked once the round has run out: then a new one is wanted.
  const signedRound = useRef('');
  // Bumped whenever this hook itself writes a fresher view (round opened, signature posted): a poll that started before is stale and is dropped.
  const epoch = useRef(0);
  const { nowMs } = o;

  const load = useCallback(async () => {
    if (!settlementId) return;
    const started = epoch.current;
    try {
      const res = await fetch(`/api/settlements/${encodeURIComponent(settlementId)}`, { cache: 'no-store' });
      if (!res.ok) { setFailure({ kind: 'load', code: (await readFailure(res)).code }); return; }
      const parsed = SettlementView.safeParse(await res.json().catch(() => null));
      if (parsed.success && epoch.current === started) { setView(parsed.data); setFailure((f) => (f?.kind === 'load' ? null : f)); }
    } catch {
      setFailure((f) => f ?? { kind: 'load' });
    }
  }, [settlementId]);

  useEffect(() => {
    if (!settlementId) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const loop = async () => {
      await load();
      if (stopped) return;
      const delay = settlementDelayMs(viewRef.current, nowMs());
      if (delay != null) timer = setTimeout(() => void loop(), delay);
    };
    void loop();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [settlementId, load, nowMs]);

  const sign = useCallback(async () => {
    const v = viewRef.current;
    if (!settlementId || !v?.role || !wallet || !signTransaction) return;
    const open = !!v.roundExpiresAt && Date.parse(v.roundExpiresAt) > nowMs();
    // One wallet prompt per run. While one is open nothing else asks, unless its round has run out: then the person's
    // "Try again" starts a new run and the old prompt's answer is dropped (a wallet popup can stay open for ever).
    if (stageRef.current === 'preparing' || (stageRef.current === 'wallet' && open)) return;
    // The round this party already signed: a poll that was in flight while the signature was posted can bring back a view from just before it.
    if (signedRound.current === `${v.id}:${v.attempt}` && open) return;
    const mine = ++run.current;
    const live = () => run.current === mine;
    setAsked(true);
    stageRef.current = 'preparing';
    setStage('preparing');
    setFailure(null);
    try {
      const { result } = await signRound(
        {
          prepare: () => postJson(`/api/settlements/${encodeURIComponent(settlementId)}/prepare`, {}, (x) => PreparedSettlement.safeParse(x)),
          assertTx: assertSettlementTx,
          signTransaction: (tx: VersionedTransaction) => signTransaction(tx),
          post: (signedTxBase64) => {
            if (!live()) throw new SettleError('api'); // a late answer from a prompt that was replaced: do not post it
            return postJson(`/api/settlements/${encodeURIComponent(settlementId)}/sign`, { role: v.role, signedTxBase64 }, (x) => SignResult.safeParse(x));
          },
          onReviewed: (r, p) => {
            if (!live()) return;
            setReview(r);
            epoch.current++;
            // The round is open as soon as the server says so: show its clock now, not at the next poll.
            setView((cur) => (cur ? { ...cur, attempt: p.attempt, roundExpiresAt: p.roundExpiresAt, buyerSigned: p.buyerSigned, sellerSigned: p.sellerSigned } : cur));
            if (r.ok) { stageRef.current = 'wallet'; setStage('wallet'); }
          },
        },
        { role: v.role, myWallet: wallet, cluster: o.cluster, agreedGross: v.role === 'buyer' ? o.agreedGross : null },
      );
      if (!live()) return;
      signedRound.current = `${result.settlement.id}:${result.settlement.attempt}`;
      epoch.current++;
      setView(result.settlement);
    } catch (e) {
      if (!live()) return;
      if (e instanceof SettleError) {
        const api = e.detail?.api;
        setFailure({
          kind: e.kind,
          problems: e.detail?.problems,
          code: api instanceof ApiProblem ? api.failure.code : undefined,
          wallet: e.kind === 'wallet' ? classifyWalletError(e.detail?.cause) : undefined,
        });
      } else {
        setFailure({ kind: 'api' });
      }
      void load();
    } finally {
      if (live()) { stageRef.current = null; setStage(null); }
    }
  }, [settlementId, wallet, signTransaction, o.cluster, o.agreedGross, load, nowMs]);

  const state: RoundState | null = view ? roundState(view, nowMs()) : null;
  const step: PayStep = payStep({ state, stage, failed: !!failure, asked });
  return { view, state, step, review, failure, busy, sign, refresh: load, wallet };
}
