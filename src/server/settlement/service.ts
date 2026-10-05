/**
 * Settlement service: drives the co-signed settlement of a sold lot.
 *
 * ENGINE creates the `settlements` row inside the closing transaction; this service only moves it through
 *   awaiting_payment --(both parties signed, SA added, sent)--> submitted --(confirmed and verified)--> settled
 *   awaiting_payment --(due_at passed)--> expired (strike on the party that did not act)
 *   awaiting_payment --(asset moved or frozen)--> failed (strike on the seller)
 * Auth is done by the routes: methods take the signed-in profile id (null = the sweep, which may only `prepare`).
 *
 * Rules that matter:
 *  - A signing round lasts min(60 s, blockhash validity). Both parties sign the SAME prepared message; the server stores
 *    signatures (columns, never in rail_state), adds SA last, re-checks the block height against the chain before sending.
 *  - Nothing holds a row lock across a network call: chain reads happen first, the write re-checks under FOR UPDATE.
 *  - `settled` is written only after the confirmed transaction's token deltas, memo and asset owner verified on chain.
 *  - One winner per settlement at submit: `UPDATE ... WHERE status = 'awaiting_payment' AND tx_signature IS NULL`, plus a
 *    unique index on tx_signature.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Keypair } from '@solana/web3.js';
import type { db as DbInstance } from '@/db';
import { auditLogs, lots, profiles, settlements, shows, showEvents } from '@/db/schema';
import {
  ApiError, AssetReadiness, EVENT_PAYLOADS, ExpectedSettlement, type Cluster, type ConsignStatus, type EventKind, type PartyRole, type PreparedSettlement,
  type SettlementService, type SettlementView, type SignInput, type SignResult,
} from '@/contracts';
import { evaluateAssetReadiness, normalizeStandard } from '@/lib/chain/asset';
import { assertFeePayerPlatform, feeWalletAddress, resolveCluster, usdcMintFor } from '@/lib/chain/config';
import { assertClusterReady } from '@/lib/chain/cluster';
import { ChainError } from '@/lib/chain/errors';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { invalidateBalance } from '@/lib/chain/funds';
import { houseSeller as loadHouseSeller, settlementAuthority } from '@/lib/chain/keys';
import { createRpcPort, type ChainPort } from '@/lib/chain/port';
import { makeRpc } from '@/lib/chain/rpc';
import { buildExpected, buildSettlementTx } from '@/lib/chain/settlement-build';
import { assembleSettlementTx, extractPartySignature, signAs } from '@/lib/chain/settlement-sign';
import { verifySettled } from '@/lib/chain/verify-settled';
import { telegramHooks } from '@/server/telegram/hooks';

type Db = typeof DbInstance;
type Row = typeof settlements.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Lot = typeof lots.$inferSelect;
type Profile = typeof profiles.$inferSelect;

export const ROUND_S = 60;
import { MAX_STRIKES } from '@/lib/auth/strikes';
const SEND_POLL_TIMEOUT_MS = 20_000;
const SWEEP_BATCH = 50;
/** The settlement path may wait longer for a node than a funds read may: a send with preflight and a parsed transaction are slow calls. */
const RPC_TIMEOUT_MS = 6000;

interface Round { attempt: number; buyerSignedAt?: string; sellerSignedAt?: string; /** Set when the simulation proved a party could not pay. */ fault?: PartyRole }
/** rail_state: breadcrumbs only. Signatures live in their own columns and are cleared when a round ends. */
interface RailState { v: 1; bidLogHash?: string; collection?: string | null; nonceAccount?: string; rounds?: Round[] }

/** The contract interface plus the two reads the routes need. */
export interface SettlementServiceX extends SettlementService {
  /** GET /api/settlements/:id: only the buyer or the seller may look (not_party), and a read finalizes lazily. `rpc_unavailable` while finalizing returns the stored state. */
  getSettlement(settlementId: string, actorProfileId: string): Promise<SettlementView>;
  /** What the sweep calls (see sweep.ts): finalize landed transactions, expire overdue settlements, drop dead round signatures. */
  sweep(now?: Date): Promise<{ expired: number; finalized: number }>;
}

export interface SettlementDeps {
  db: Db;
  chainFor: (cluster: Cluster) => ChainPort;
  /** SA: fee payer, rent payer, third signer. No authority over any asset. */
  sa: Keypair;
  /** The platform's own devnet test-asset owner; the server signs its seller leg at prepare. */
  houseSeller: Keypair | null;
  usdcMint: (cluster: Cluster) => string;
  feeWallet: string;
  defaultCluster: Cluster;
  now?: () => Date;
  roundS?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  assertCluster?: (cluster: Cluster) => void;
  /**
   * Called right before SA adds its signature to a settlement whose seller is NOT the platform's house seller; throws to refuse.
   * SA pays the network fee and the rent of up to three new token accounts for every settlement, and anybody may become a seller
   * with a card of their own, so this is where unattended spending is capped (production: a daily budget, see getSettlementService).
   */
  spendGuard?: (kind: 'house' | 'third-party') => Promise<void>;
}

/**
 * Who did not act? The party that was NOT present in the most recent round that had any signature; nobody signed means the buyer.
 * A round both parties signed was lost to the platform or the chain (SA budget, SA out of SOL, RPC down): nobody is at fault (null),
 * unless the simulation recorded a fault (the buyer's USDC was gone).
 */
export function atFault(rounds: Round[] = []): PartyRole | null {
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i]!;
    if (r.fault) return r.fault;
    if (r.buyerSignedAt && r.sellerSignedAt) return null;
    if (r.buyerSignedAt && !r.sellerSignedAt) return 'seller';
    if (r.sellerSignedAt && !r.buyerSignedAt) return 'buyer';
  }
  return 'buyer';
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const iso = (d: Date) => d.toISOString();
const usd = (gross: bigint) => { const c = gross / 10_000n; return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`; }; // USDC is priced 1:1 in dollars, cents only

export function createSettlementService(deps: SettlementDeps): SettlementServiceX {
  const { db, sa } = deps;
  const now = () => (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const roundS = deps.roundS ?? ROUND_S;
  const guard = deps.assertCluster ?? ((c: Cluster) => assertClusterReady(c));

  // ---- loading and views ------------------------------------------------------------------------------------------------

  interface Ctx { row: Row; buyer: Profile; seller: Profile; lot: Lot; cluster: Cluster }

  async function load(executor: Db | Tx, id: string, lock = false): Promise<Ctx> {
    const q = executor.select().from(settlements).where(eq(settlements.id, id));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new ApiError('not_found', 'no such settlement');
    const [buyer] = await executor.select().from(profiles).where(eq(profiles.id, row.buyerId));
    const [seller] = await executor.select().from(profiles).where(eq(profiles.id, row.sellerId));
    const [lot] = await executor.select().from(lots).where(eq(lots.id, row.lotId));
    if (!buyer || !seller || !lot) throw new ApiError('not_found', 'settlement is missing its buyer, seller or lot');
    const cluster = (row.cluster ?? deps.defaultCluster) as Cluster;
    return { row, buyer, seller, lot, cluster };
  }

  const isLive = (row: Row, at: Date) => row.status === 'awaiting_payment' && !!row.preparedMessage && !!row.roundExpiresAt && row.roundExpiresAt > at;
  const roleOf = (c: Ctx, actor: string | null | undefined): PartyRole | null => (actor === c.row.buyerId ? 'buyer' : actor === c.row.sellerId ? 'seller' : null);

  function view(c: Ctx, actor?: string | null): SettlementView {
    const { row } = c, at = now(), live = isLive(row, at);
    const done = row.status === 'submitted' || row.status === 'settled';
    const v: SettlementView = {
      id: row.id, lotId: row.lotId, status: row.status as SettlementView['status'], rail: row.rail as SettlementView['rail'], cluster: c.cluster, attempt: row.attempt,
      gross: row.grossAmount.toString(), platformFee: row.platformFee.toString(), sellerAmount: row.sellerAmount.toString(), royalty: row.royaltyAmount.toString(),
      dueAt: iso(row.dueAt ?? at), roundExpiresAt: live ? iso(row.roundExpiresAt!) : null,
      buyerSigned: done || (live && !!row.buyerSignature), sellerSigned: done || (live && !!row.sellerSignature), role: roleOf(c, actor),
    };
    if (row.txSignature) { v.txSignature = row.txSignature; v.explorerUrl = explorerTxUrl(row.txSignature, c.cluster); }
    if (row.failureCode) v.failure = { code: row.failureCode, detail: row.failureDetail };
    return v;
  }

  function expectedFor(c: Ctx): ExpectedSettlement {
    const rail = (c.row.railState ?? {}) as RailState;
    const bidLogHash = c.row.bidLogHash ?? rail.bidLogHash;
    if (!bidLogHash) throw new ApiError('wrong_state', 'settlement has no bid log hash');
    if (!c.row.mintAddress) throw new ApiError('wrong_state', 'settlement has no asset');
    const e = buildExpected({
      settlementId: c.row.id, cluster: c.cluster, buyer: c.buyer.walletAddress, seller: c.seller.walletAddress, asset: c.row.mintAddress, collection: rail.collection ?? null,
      usdcMint: deps.usdcMint(c.cluster), gross: c.row.grossAmount, platformFee: c.row.platformFee, royalty: c.row.royaltyAmount, royaltyRecipient: c.row.royaltyRecipient,
      feeWallet: deps.feeWallet, feePayer: sa.publicKey.toBase58(), bidLogHash, lifetime: 'blockhash',
    });
    if (c.row.memo && c.row.memo !== e.memo) throw new ApiError('wrong_state', 'settlement memo does not match its id and bid log hash');
    return e;
  }

  // ---- small writers (all idempotent) -------------------------------------------------------------------------------------

  async function event(tx: Db | Tx, c: Ctx, kind: EventKind, extra: Record<string, unknown>) {
    if (!c.lot.showId) return;
    const payload = EVENT_PAYLOADS[kind].parse({ lotId: c.lot.id, lotNumber: c.lot.lotNumber, settlementId: c.row.id, ...extra });
    await tx.insert(showEvents).values({ showId: c.lot.showId, kind, payload });
  }
  const audit = (tx: Db | Tx, action: string, target: string, detail: Record<string, unknown>) =>
    tx.insert(auditLogs).values({ actorWallet: null, action, target, detail });

  /** A strike on `who`; the third one bans. The platform's own house seller is never struck. */
  async function strike(tx: Tx, c: Ctx, who: PartyRole, reason: string) {
    const p = who === 'buyer' ? c.buyer : c.seller;
    if (p.isBot || p.walletAddress === deps.houseSeller?.publicKey.toBase58()) return;
    const [u] = await tx.update(profiles).set({ strikes: sql`${profiles.strikes} + 1`, updatedAt: now() }).where(eq(profiles.id, p.id)).returning({ strikes: profiles.strikes });
    if (u && u.strikes >= MAX_STRIKES) await tx.update(profiles).set({ isBanned: true, bannedReason: `${MAX_STRIKES} settlements not completed`, bannedAt: now() }).where(eq(profiles.id, p.id));
    await audit(tx, 'strike', p.id, { settlementId: c.row.id, reason, strikes: u?.strikes });
  }

  /** Records on the round of `attempt` which party the simulation proved unable to pay; atFault reads it. */
  async function markFault(id: string, attempt: number, who: PartyRole) {
    await db.transaction(async (tx) => {
      const cur = await load(tx, id, true);
      const rail = { ...((cur.row.railState as RailState | null) ?? {}), v: 1 as const };
      const rounds = [...(rail.rounds ?? [])];
      const at = rounds.findLastIndex((r) => r.attempt === attempt);
      if (at < 0) return;
      rounds[at] = { ...rounds[at]!, fault: who };
      await tx.update(settlements).set({ railState: { ...rail, rounds } }).where(eq(settlements.id, id));
    });
  }

  const dropSignatures = { buyerSignature: null, sellerSignature: null } as const;

  /** Ends the current round without sending: signatures die, status stays awaiting_payment, a new `prepare` starts attempt + 1. */
  async function dropRound(id: string, code: string | null, detail: string | null, from: 'awaiting_payment' | 'submitted' = 'awaiting_payment') {
    await db.update(settlements)
      .set({ ...dropSignatures, status: 'awaiting_payment', txSignature: null, submittedAt: null, roundExpiresAt: now(), failureCode: code, failureDetail: detail })
      .where(and(eq(settlements.id, id), eq(settlements.status, from)));
  }

  async function expireOne(id: string, at = now()): Promise<boolean> {
    return db.transaction(async (tx) => {
      const c = await load(tx, id, true);
      if (c.row.status !== 'awaiting_payment' || !c.row.dueAt || c.row.dueAt > at) return false;
      const who = atFault((c.row.railState as RailState | null)?.rounds);
      await tx.update(settlements).set({ status: 'expired', failureCode: 'expired', failureDetail: who ? `${who} did not complete the settlement` : 'the signed transaction could not be sent in time', ...dropSignatures, roundExpiresAt: null }).where(eq(settlements.id, id));
      if (who) await strike(tx, c, who, 'settlement expired'); // both signed and it still did not go through: the platform or the chain failed, not a party
      await event(tx, c, 'settlement.expired', {});
      await audit(tx, 'settlement.expired', id, { atFault: who ?? 'none' });
      return true;
    });
  }

  async function failOne(id: string, code: string, detail: string, who: PartyRole | null) {
    await db.transaction(async (tx) => {
      const c = await load(tx, id, true);
      if (c.row.status !== 'awaiting_payment' && c.row.status !== 'submitted') return;
      await tx.update(settlements).set({ status: 'failed', failureCode: code, failureDetail: detail.slice(0, 300), ...dropSignatures, roundExpiresAt: null }).where(eq(settlements.id, id));
      if (who) await strike(tx, c, who, code);
      await audit(tx, 'settlement.failed', id, { code, detail: detail.slice(0, 300) });
    });
  }

  // ---- prepare ------------------------------------------------------------------------------------------------------------

  function prepared(c: Ctx): PreparedSettlement {
    const { row } = c;
    return {
      attempt: row.attempt, txBase64: row.preparedMessage!, expected: expectedFor(c), lastValidBlockHeight: row.lastValidHeight ?? null,
      roundExpiresAt: iso(row.roundExpiresAt!), dueAt: iso(row.dueAt ?? now()), buyerSigned: !!row.buyerSignature, sellerSigned: !!row.sellerSignature,
    };
  }

  async function prepareSettlement(id: string, actor: string | null): Promise<PreparedSettlement> {
    let c = await load(db, id);
    if (actor !== null && !roleOf(c, actor)) throw new ApiError('not_party', 'you are not the buyer or the seller of this settlement');
    if (c.row.status === 'submitted') c = await load(db, (await finalizeSettlement(id)).id);
    if (c.row.status !== 'awaiting_payment') throw new ApiError('wrong_state', `settlement is ${c.row.status}`);
    if (c.row.dueAt && c.row.dueAt <= now()) { await expireOne(id); throw new ApiError('wrong_state', 'the settlement window has closed'); }
    guard(c.cluster);
    if (isLive(c.row, now())) return prepared(c); // idempotent inside a live round: same message

    // Chain reads first, no lock held.
    const chain = deps.chainFor(c.cluster);
    if ((await chain.getUsdcBalance(c.buyer.walletAddress)) < c.row.grossAmount) throw new ApiError('insufficient_usdc', 'the buyer does not hold enough USDC');
    const mint = c.row.mintAddress;
    if (!mint) throw new ApiError('wrong_state', 'settlement has no asset');
    const info = normalizeStandard(c.lot.nftStandard) === 'core' ? await chain.readAsset(mint) : null;
    const readiness = normalizeStandard(c.lot.nftStandard) === 'core' ? evaluateAssetReadiness(info, { seller: c.seller.walletAddress }) : { eligible: false, reasons: ['unsupported_standard'] };
    if (!readiness.eligible) {
      await failOne(id, 'asset_not_ready', readiness.reasons.join(','), 'seller');
      throw new ApiError('asset_not_ready', `the card can no longer be transferred (${readiness.reasons.join(', ')})`);
    }
    const [bh, height] = await Promise.all([chain.getLatestBlockhash(), chain.getBlockHeight()]);
    const validS = Math.floor((bh.lastValidBlockHeight - height) * 0.4);
    if (validS < 10) throw new ApiError('rpc_unavailable', 'the latest blockhash is too old, try again');
    const lengthS = Math.min(roundS, validS);

    const base = { ...c, row: { ...c.row, railState: { ...((c.row.railState as RailState | null) ?? {}), v: 1, collection: info?.collection ?? null } } };
    const expected = expectedFor(base as Ctx);
    const { txBytes, txBase64 } = buildSettlementTx(expected, bh.blockhash);
    let houseSig: string | null = null;
    if (deps.houseSeller && c.seller.walletAddress === deps.houseSeller.publicKey.toBase58()) {
      houseSig = b64(extractPartySignature(signAs(txBytes, deps.houseSeller), txBytes, expected, 'seller'));
    }

    return db.transaction(async (tx) => {
      const cur = await load(tx, id, true);
      if (cur.row.status !== 'awaiting_payment') throw new ApiError('wrong_state', `settlement is ${cur.row.status}`);
      if (isLive(cur.row, now())) return prepared(cur); // a concurrent prepare won: return its message
      const at = now();
      const attempt = cur.row.preparedMessage ? cur.row.attempt + 1 : cur.row.attempt;
      const rail = { ...((cur.row.railState as RailState | null) ?? {}), v: 1 as const, collection: info?.collection ?? null };
      rail.rounds = [...(rail.rounds ?? []), { attempt, ...(houseSig ? { sellerSignedAt: iso(at) } : {}) }];
      const [u] = await tx.update(settlements).set({
        attempt, preparedMessage: txBase64, preparedBlockhash: bh.blockhash, lastValidHeight: bh.lastValidBlockHeight, roundExpiresAt: new Date(at.getTime() + lengthS * 1000),
        buyerSignature: null, sellerSignature: houseSig, failureCode: null, failureDetail: null, bidLogHash: cur.row.bidLogHash ?? rail.bidLogHash ?? null, railState: rail,
      }).where(eq(settlements.id, id)).returning();
      return prepared({ ...cur, row: u! });
    });
  }

  // ---- sign ---------------------------------------------------------------------------------------------------------------

  async function signSettlement(id: string, actor: string, input: SignInput): Promise<SignResult> {
    const c = await load(db, id);
    const role = input.role;
    if (actor !== (role === 'buyer' ? c.row.buyerId : c.row.sellerId)) throw new ApiError('not_party', `you are not the ${role} of this settlement`);
    if (c.row.status === 'submitted' || c.row.status === 'settled') return { step: c.row.status, settlement: view(c, actor) };
    if (c.row.status !== 'awaiting_payment') throw new ApiError('wrong_state', `settlement is ${c.row.status}`);
    guard(c.cluster);
    if (!isLive(c.row, now())) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');

    const preparedBytes = unb64(c.row.preparedMessage!);
    const sig = extractPartySignature(unb64(input.signedTxBase64), preparedBytes, expectedFor(c), role);

    const stored = await db.transaction(async (tx) => {
      const cur = await load(tx, id, true);
      if (cur.row.status !== 'awaiting_payment') return cur;
      if (!isLive(cur.row, now()) || cur.row.preparedMessage !== c.row.preparedMessage) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');
      const rail = { ...((cur.row.railState as RailState | null) ?? {}), v: 1 as const };
      const rounds = [...(rail.rounds ?? [])];
      const at = rounds.findLastIndex((r) => r.attempt === cur.row.attempt);
      const mark = role === 'buyer' ? 'buyerSignedAt' : 'sellerSignedAt';
      if (at >= 0) { if (!rounds[at]![mark]) rounds[at] = { ...rounds[at]!, [mark]: iso(now()) }; } else rounds.push({ attempt: cur.row.attempt, [mark]: iso(now()) });
      const [u] = await tx.update(settlements).set({ [role === 'buyer' ? 'buyerSignature' : 'sellerSignature']: b64(sig), railState: { ...rail, rounds } }).where(eq(settlements.id, id)).returning();
      return { ...cur, row: u! };
    });
    if (!(stored.row.buyerSignature && stored.row.sellerSignature)) return { step: 'awaiting_counterparty', settlement: view(stored, actor) };
    return sendRound(id, actor);
  }

  /** Both signatures are stored. Add SA, check the block height, simulate, claim, send, poll, finalize. */
  async function sendRound(id: string, actor: string | null): Promise<SignResult> {
    const c = await load(db, id);
    guard(c.cluster);
    const chain = deps.chainFor(c.cluster);
    if (c.row.status !== 'awaiting_payment') return { step: c.row.status === 'settled' ? 'settled' : 'submitted', settlement: view(c, actor) };
    if (!c.row.buyerSignature || !c.row.sellerSignature || !c.row.preparedMessage) throw new ApiError('counterparty_pending', 'both parties must sign first');
    if (!isLive(c.row, now()) || (await chain.getBlockHeight()) > (c.row.lastValidHeight ?? 0)) { // authoritative: the chain, not our clock
      await dropRound(id, 'round_expired', null);
      throw new ApiError('round_expired', 'the signing round ended before the transaction could be sent');
    }
    const e = expectedFor(c);
    const { wire, signature } = assembleSettlementTx(unb64(c.row.preparedMessage), e, { buyer: unb64(c.row.buyerSignature), seller: unb64(c.row.sellerSignature) }, sa);
    const wire64 = b64(wire);

    const sim = await chain.simulate(wire64);
    if (sim.err) {
      // A concurrent request (a double click, two tabs) may have claimed, sent and landed this very transaction a moment ago: the node
      // then calls ours "already processed". That is not a failure; answer with where the winner has taken it.
      const winner = await load(db, id);
      if (winner.row.status !== 'awaiting_payment') return { step: winner.row.status === 'settled' ? 'settled' : 'submitted', settlement: view(winner, actor) };
      const text = `${JSON.stringify(sim.err)} ${sim.logs.join(' ')}`;
      console.warn('settlement simulation failed', id, text.slice(0, 600)); // the program logs stay in OUR log: they can carry account balances (SA's too)
      const short = /insufficient funds|InsufficientFunds|custom program error: 0x1\b/i.test(text);
      if (short) await markFault(id, c.row.attempt, 'buyer'); // the buyer signed and then could not pay: that stays the buyer's strike
      throw new ApiError(short ? 'insufficient_usdc' : 'simulation_failed', `the network rejected the transaction in simulation: ${JSON.stringify(sim.err).slice(0, 120)}`);
    }

    // Sponsorship is spent only for a transaction that passed simulation, so failing attempts cost the budget nothing (a loop of them
    // cannot drain it). Nothing was sent yet: a refusal here keeps the round open and both signatures.
    await deps.spendGuard?.(deps.houseSeller && c.seller.walletAddress === deps.houseSeller.publicKey.toBase58() ? 'house' : 'third-party');

    // One winner: only a row still awaiting payment with no transaction yet may be claimed.
    let claimed: Row | undefined;
    try {
      [claimed] = await db.update(settlements).set({ status: 'submitted', txSignature: signature, submittedAt: now(), failureCode: null, failureDetail: null })
        .where(and(eq(settlements.id, id), eq(settlements.status, 'awaiting_payment'), sql`${settlements.txSignature} is null`)).returning();
    } catch {
      throw new ApiError('wrong_state', 'this transaction is already recorded');
    }
    if (!claimed) { const now2 = await load(db, id); return { step: now2.row.status === 'settled' ? 'settled' : 'submitted', settlement: view(now2, actor) }; }
    await event(db, c, 'settlement.submitted', { txSignature: signature });

    try {
      const sent = await chain.send(wire64);
      if (sent !== signature) throw new ApiError('simulation_failed', 'the node returned a different signature');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'blockhash_expired' || err.code === 'simulation_failed')) {
        await dropRound(id, err.code === 'blockhash_expired' ? 'round_expired' : 'simulation_failed', err.message.slice(0, 300), 'submitted');
        throw err.code === 'blockhash_expired' ? new ApiError('round_expired', 'the signing round ended before the transaction could be sent') : err;
      }
      // Outcome unknown (RPC down mid-send): it may have landed. Stay `submitted`; finalize decides from the chain.
    }

    const deadline = Date.now() + SEND_POLL_TIMEOUT_MS;
    let result = await finalizeSettlement(id, actor);
    while (result.status === 'submitted' && Date.now() < deadline) {
      await sleep(deps.pollMs ?? 1000);
      result = await finalizeSettlement(id, actor);
    }
    return { step: result.status === 'settled' ? 'settled' : 'submitted', settlement: result };
  }

  // ---- finalize -----------------------------------------------------------------------------------------------------------

  async function finalizeSettlement(id: string, actor?: string | null): Promise<SettlementView> {
    const c = await load(db, id);
    if (c.row.status === 'awaiting_payment' && c.row.dueAt && c.row.dueAt <= now()) { await expireOne(id); return view(await load(db, id), actor); }
    if (c.row.status !== 'submitted' || !c.row.txSignature) return view(c, actor);
    const chain = deps.chainFor(c.cluster);
    const sig = c.row.txSignature;
    const st = await chain.getSignatureStatus(sig);
    if (!st) {
      if ((await chain.getBlockHeight()) > (c.row.lastValidHeight ?? 0)) await dropRound(id, 'round_expired', 'the transaction never landed', 'submitted'); // dead: a new round may start
      return view(await load(db, id), actor);
    }
    if (!st.confirmed) return view(c, actor);
    if (st.err) { await dropRound(id, 'tx_failed', JSON.stringify(st.err).slice(0, 300), 'submitted'); return view(await load(db, id), actor); }

    const e = expectedFor(c);
    const [parsed, asset] = await Promise.all([chain.getTransaction(sig), chain.readAsset(e.asset)]);
    if (!parsed) return view(c, actor); // the node has not indexed it yet; ask again
    const verdict = verifySettled(parsed, e, asset?.owner ?? null);
    if (!verdict.ok) { await failOne(id, verdict.code, verdict.detail, null); return view(await load(db, id), actor); }

    await db.transaction(async (tx) => {
      const cur = await load(tx, id, true);
      if (cur.row.status !== 'submitted') return;
      await tx.update(settlements).set({ status: 'settled', settledAt: now(), usdValueAtTime: usd(cur.row.grossAmount), failureCode: null, failureDetail: null, ...dropSignatures, roundExpiresAt: null }).where(eq(settlements.id, id));
      await event(tx, cur, 'settlement.settled', { txSignature: sig });
      await audit(tx, 'settlement.settled', id, { txSignature: sig });
    });
    invalidateBalance(c.buyer.walletAddress);
    invalidateBalance(c.seller.walletAddress);
    telegramHooks.settled(id); // Telegram: card and receipt to the buyer and the seller who asked for it (never throws, runs after the response)
    return view(await load(db, id), actor);
  }

  // ---- expiry (the sweep) -------------------------------------------------------------------------------------------------

  // Known limit: one pass handles at most SWEEP_BATCH rows per kind so a cron call fits a serverless time limit; the next minute takes the rest.
  async function sweep(at: Date = now()): Promise<{ expired: number; finalized: number }> {
    const submitted = await db.select({ id: settlements.id }).from(settlements).where(eq(settlements.status, 'submitted')).limit(SWEEP_BATCH);
    let finalized = 0;
    for (const s of submitted) { // a landed transaction settles instead of expiring
      const v = await finalizeSettlement(s.id).catch(() => null);
      if (v?.status === 'settled') finalized++;
    }
    const due = await db.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.status, 'awaiting_payment'), lte(settlements.dueAt, at))).limit(SWEEP_BATCH);
    let expired = 0;
    for (const s of due) if (await expireOne(s.id, at)) expired++;
    // Hygiene: signatures of rounds that ended unsigned do not outlive the round.
    await db.update(settlements).set({ ...dropSignatures }).where(and(eq(settlements.status, 'awaiting_payment'), lte(settlements.roundExpiresAt, at)));
    return { expired, finalized };
  }
  const expireDue = async (at?: Date): Promise<number> => (await sweep(at)).expired;

  // ---- read ---------------------------------------------------------------------------------------------------------------

  async function getSettlement(id: string, actor: string): Promise<SettlementView> {
    const c = await load(db, id);
    if (!roleOf(c, actor)) throw new ApiError('not_party', 'you are not the buyer or the seller of this settlement');
    try {
      return await finalizeSettlement(id, actor);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rpc_unavailable') return view(await load(db, id), actor); // a read never fails because the chain is slow
      throw e;
    }
  }

  // ---- consign readiness --------------------------------------------------------------------------------------------------

  async function checkReadiness(lotId: string, sellerProfileId: string): Promise<{ readiness: AssetReadiness; consign: ConsignStatus }> {
    const [lot] = await db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot) throw new ApiError('not_found', 'no such lot');
    if (lot.sellerId !== sellerProfileId) throw new ApiError('not_seller', 'this lot is not yours');
    const [seller] = await db.select().from(profiles).where(eq(profiles.id, sellerProfileId));
    const [show] = lot.showId ? await db.select({ cluster: shows.cluster }).from(shows).where(eq(shows.id, lot.showId)) : [];
    const cluster = (show?.cluster ?? deps.defaultCluster) as Cluster;
    let readiness: AssetReadiness;
    if (normalizeStandard(lot.nftStandard) !== 'core') readiness = { eligible: false, reasons: ['unsupported_standard'] };
    else readiness = evaluateAssetReadiness(await deps.chainFor(cluster).readAsset(lot.mintAddress), { seller: seller!.walletAddress });
    // Only a lot still in the catalogue changes: a sold or open lot keeps the flag it was opened with.
    const consign: ConsignStatus = lot.state !== 'catalogued' ? (lot.consignStatus as ConsignStatus) : readiness.eligible ? 'ready' : 'rejected';
    if (lot.state === 'catalogued') await db.update(lots).set({ consignStatus: consign }).where(eq(lots.id, lotId));
    return { readiness: AssetReadiness.parse(readiness), consign };
  }

  return { prepareSettlement, signSettlement, finalizeSettlement, expireDue, checkReadiness, getSettlement, sweep };
}

// ---- the production instance: built on first use so importing this module never needs DATABASE_URL or keys -------------

let instance: SettlementServiceX | undefined;
let override: SettlementServiceX | undefined;
/** Tests inject a service built on LiteSVM; pass undefined to go back to the real one. */
export function setSettlementService(s?: SettlementServiceX): void {
  override = s;
}
/** Third-party (not house) settlements SA will sponsor per day: about 0.008 SOL each, so the default is at most 0.32 SOL a day. SA_THIRD_PARTY_SETTLEMENTS_PER_DAY overrides. */
export const DEFAULT_THIRD_PARTY_SETTLEMENTS_PER_DAY = 40;
/**
 * The house room's own sales get a bigger budget, not a free pass: anybody can fund wallets from the faucet and buy house lots one after
 * another, and without a ceiling that drains SA's SOL in hours. At most about 1 SOL a day. SA_HOUSE_SETTLEMENTS_PER_DAY overrides.
 */
export const DEFAULT_HOUSE_SETTLEMENTS_PER_DAY = 120;

/**
 * One shared counter per kind in the rate_limits table (every instance), 24 h fixed window. A refusal is a 429 with the time left.
 * Pack sales count in their own counters (`scope: 'pack'`, same limits) so a flood of packs cannot starve auction settlements.
 */
export async function sponsorBudgetGuard(env: Record<string, string | undefined> = process.env, kind: 'house' | 'third-party' = 'third-party', scope: 'settlement' | 'pack' = 'settlement'): Promise<void> {
  const house = kind === 'house';
  const n = Number(house ? env.SA_HOUSE_SETTLEMENTS_PER_DAY : env.SA_THIRD_PARTY_SETTLEMENTS_PER_DAY);
  const limit = Number.isInteger(n) && n >= 0 ? n : house ? DEFAULT_HOUSE_SETTLEMENTS_PER_DAY : DEFAULT_THIRD_PARTY_SETTLEMENTS_PER_DAY;
  const { assertRate, rateLimit } = await import('@/lib/http/ratelimit');
  const key = scope === 'pack' ? (house ? 'g:sa-pack-house' : 'g:sa-pack-third-party') : (house ? 'g:sa-house-settlement' : 'g:sa-third-party-settlement');
  assertRate(await rateLimit(key, limit, 86_400));
}

export function getSettlementService(): SettlementServiceX {
  if (override) return override;
  if (instance) return instance;
  let real: Promise<SettlementServiceX> | undefined;
  const get = () => (real ??= import('@/db').then(({ db }) => {
    assertFeePayerPlatform(); // FEE_PAYER=buyer is not built: refuse it loudly instead of ignoring it
    const fee = feeWalletAddress();
    if (!fee) throw new ChainError('paused', 'Payments are paused: the platform wallet is not configured.');
    return createSettlementService({ db, chainFor: (c) => createRpcPort(c, makeRpc(c, { timeoutMs: RPC_TIMEOUT_MS })), sa: settlementAuthority(), houseSeller: loadHouseSeller(), usdcMint: (c) => usdcMintFor(c), feeWallet: fee, defaultCluster: resolveCluster(), spendGuard: (kind) => sponsorBudgetGuard(process.env, kind) });
  }).catch((e) => { real = undefined; throw e; })); // a failed start is not remembered: the next request tries again
  instance = {
    prepareSettlement: async (...a) => (await get()).prepareSettlement(...a),
    signSettlement: async (...a) => (await get()).signSettlement(...a),
    finalizeSettlement: async (...a) => (await get()).finalizeSettlement(...a),
    expireDue: async (...a) => (await get()).expireDue(...a),
    checkReadiness: async (...a) => (await get()).checkReadiness(...a),
    getSettlement: async (...a) => (await get()).getSettlement(...a),
    sweep: async (...a) => (await get()).sweep(...a),
  };
  return instance;
}
