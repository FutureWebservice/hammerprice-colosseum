/**
 * The few read-only chain calls the "recompute it yourself" check needs, behind a small interface so the check is
 * testable with a fake and runs in the browser against the public RPC of the request's cluster (fetch only).
 * All reads use `finalized`. The caller passes the URL (from config); this file knows no cluster.
 */
export interface ChainTx {
  slot: number;
  blockTime: number | null;
  failed: boolean;
  signers: string[];
  memos: string[];
}
export interface SigInfo { signature: string; slot: number; blockTime: number | null; failed: boolean; memos: string[] }

export interface VrfRpc {
  getTx(signature: string): Promise<ChainTx | null>;
  /** Confirmed slots in [start, end], ascending. */
  getBlocks(start: number, end: number): Promise<number[]>;
  getBlockhash(slot: number): Promise<string | null>;
  /** Newest first, at most 1000 per call; `before` pages backwards. */
  getSignatures(address: string, before?: string): Promise<SigInfo[]>;
}

/** getSignaturesForAddress renders memos as "[len] text" and joins several with "; ". */
export function parseSigMemo(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split('; ').map((m) => m.replace(/^\[\d+\] /, ''));
}

type Fetch = typeof fetch;
const FINAL = { commitment: 'finalized' } as const;

export function createFetchRpc(url: string, opts: { fetch?: Fetch } = {}): VrfRpc {
  const f = opts.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
  let n = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result as T;
  }
  return {
    async getTx(signature) {
      const r = await call<null | {
        slot: number;
        blockTime: number | null;
        meta: { err: unknown } | null;
        transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: { program?: string; parsed?: unknown }[] } };
      }>('getTransaction', [signature, { ...FINAL, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!r) return null;
      const m = r.transaction.message;
      return {
        slot: r.slot,
        blockTime: r.blockTime,
        failed: !!r.meta?.err,
        signers: m.accountKeys.filter((k) => k.signer).map((k) => k.pubkey),
        memos: m.instructions.filter((i) => i.program === 'spl-memo' && typeof i.parsed === 'string').map((i) => i.parsed as string),
      };
    },
    getBlocks: (start, end) => call<number[]>('getBlocks', [start, end, FINAL]),
    async getBlockhash(slot) {
      try {
        const b = await call<{ blockhash: string } | null>('getBlock', [slot, { ...FINAL, transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
        return b?.blockhash ?? null;
      } catch (e) {
        if (/skipped|not available|cleaned up/i.test((e as Error).message)) return null; // a missing block is "unknown", not a transport failure
        throw e;
      }
    },
    async getSignatures(address, before) {
      const r = await call<{ signature: string; slot: number; blockTime: number | null; err: unknown; memo: string | null }[]>('getSignaturesForAddress', [
        address,
        { ...FINAL, limit: 1000, ...(before ? { before } : {}) },
      ]);
      return r.map((x) => ({ signature: x.signature, slot: x.slot, blockTime: x.blockTime, failed: !!x.err, memos: parseSigMemo(x.memo) }));
    },
  };
}
