/**
 * Rows to contract shapes, and the one rule about what the public may see before a purchase is over: a card reserved for a buyer shows as
 * available, and the result of a draw (tier, card, proof) is shown only once the draw ended (delivered, demo_revealed, expired, failed or undelivered: the buyer needs the proof to claim against an operator who did not deliver).
 * A pay_first purchase has no card at all until its payment is finalized (card_id, asset, tier and every VRF column are null until then), and
 * this file additionally keeps the result hidden while the card is being delivered, so the reveal plays for the person who paid.
 */
import { PackDrawView, PackView, type Cluster, type PackOperatorRecord } from '@/contracts';
import type { packDefinitions, packDraws, packPoolCards, vrfRequests } from '@/db/schema';
import { explorerTxUrl } from '@/lib/chain/explorer';

export type PackRow = typeof packDefinitions.$inferSelect;
export type CardRow = typeof packPoolCards.$inferSelect;
export type DrawRow = typeof packDraws.$inferSelect;
export type VrfRow = typeof vrfRequests.$inferSelect;

interface StoredTier { tier: string; label: { de: string; en: string }; bps: number }
export const oddsOf = (p: PackRow): StoredTier[] => p.odds as StoredTier[];
const iso = (d: Date) => d.toISOString();

/** Draws that have reached their end; only then is the result public. (A pay_first draw that is still being delivered is not at its end.) */
export const isDrawRevealed = (status: string): boolean => status === 'settled' || status === 'failed' || status === 'expired' || status === 'undelivered' || status === 'demo_revealed';

/** "PSA 10" from the card's attributes (grading company and grade), or null when the operator gave none. */
export const gradeOf = (c: Pick<CardRow, 'attributes'>): string | null => {
  const a = (c.attributes ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const company = str(a.grading_company), grade = str(a.grade);
  const g = company && grade && !grade.toLowerCase().startsWith(company.toLowerCase()) ? `${company} ${grade}` : grade || company;
  return g || null;
};

/** `committed` positions: the pool as it was committed (card order = position). */
export const sortedCards = (cards: CardRow[]): CardRow[] => [...cards].sort((a, b) => a.position - b.position);

export function packView(p: PackRow, cards: CardRow[], vrfPublicKey: string | null, operatorRecord: PackOperatorRecord | null = null): PackView {
  const mine = cards.filter((c) => c.packId === p.id);
  const inPlay = (c: CardRow) => c.status === 'available' || c.status === 'reserved'; // a reservation is not public
  return PackView.parse({
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    imageUrl: p.imageUrl ?? null,
    mode: p.mode,
    status: p.status,
    cluster: p.cluster as Cluster,
    price: p.price.toString(),
    operator: { wallet: p.operatorWallet, isHouse: p.isHouse },
    odds: oddsOf(p).map((o) => ({ tier: o.tier, label: o.label, bps: o.bps, remaining: mine.filter((c) => c.tier === o.tier && inPlay(c)).length, total: mine.filter((c) => c.tier === o.tier && c.status !== 'removed').length })),
    pool: { total: mine.filter((c) => c.status !== 'removed').length, remaining: mine.filter(inPlay).length },
    commitment: { poolHash: p.poolHash ?? null, oddsHash: p.oddsHash ?? null, committedAt: p.committedAt ? iso(p.committedAt) : null },
    perWalletDailyCap: p.perWalletDailyCap,
    operatorRecord: p.isHouse ? null : operatorRecord,
    vrfPublicKey,
    createdAt: iso(p.createdAt),
  });
}

export function poolCardViews(cards: CardRow[]) {
  return sortedCards(cards).map((c) => ({
    id: c.id, position: c.position, asset: c.asset, tier: c.tier, name: c.name, imageUrl: c.imageUrl ?? null, listedValue: c.listedValue === null ? null : c.listedValue.toString(), grade: gradeOf(c),
    status: (c.status === 'reserved' ? 'available' : c.status) as 'available' | 'drawn' | 'removed',
  }));
}

export function drawView(d: DrawRow, pack: Pick<PackRow, 'poolHash' | 'cluster' | 'operatorWallet' | 'isHouse'>, vrf: VrfRow | null, card: CardRow | null, o: { expiresAt?: Date | null } = {}): PackDrawView {
  const revealed = isDrawRevealed(d.status);
  const tier = revealed ? d.tier ?? null : null;
  return PackDrawView.parse({
    id: d.id,
    packId: d.packId,
    drawIndex: d.drawIndex,
    status: d.status,
    cluster: d.cluster as Cluster,
    buyer: d.buyerWallet,
    clientSeed: d.clientSeed,
    poolHash: pack.poolHash ?? '0'.repeat(64),
    vrf: {
      requestId: revealed ? vrf?.id ?? null : null, // the id would open the public VRF view; it appears with the result
      status: revealed ? ((vrf?.status as never) ?? null) : null,
      input: revealed ? d.vrfInput ?? null : null,
      proofHex: revealed ? d.proofHex ?? null : null,
      outputHex: revealed ? d.outputHex ?? null : null,
      params: revealed ? ((vrf?.params as Record<string, unknown>) ?? null) : null,
      paramsHash: revealed ? vrf?.paramsHash ?? null : null,
      beacon: revealed && vrf?.beaconSlot && vrf.beaconBlockhash ? { slot: vrf.beaconSlot, blockhash: vrf.beaconBlockhash } : null,
      publicKey: revealed ? vrf?.publicKey ?? null : null,
    },
    revealed,
    tier,
    card: revealed && card ? { asset: card.asset, name: card.name, imageUrl: card.imageUrl ?? null, tier: card.tier, grade: gradeOf(card) } : null,
    price: d.price.toString(),
    settlementRef: d.settlementRef ?? null,
    txSignature: d.txSignature ?? null,
    createdAt: iso(d.createdAt),
    settledAt: d.settledAt ? iso(d.settledAt) : null,
    flow: d.flow === 'pay_first' ? 'pay_first' : 'atomic',
    deliverySignature: revealed ? d.deliverySignature ?? null : null, // the delivery transaction names the card on chain: shown with the result
    paidAt: d.paidAt ? iso(d.paidAt) : null,
    paymentSlot: d.paymentSlot ?? null,
    expiresAt: d.status === 'awaiting_payment' && o.expiresAt ? iso(o.expiresAt) : null,
    operator: { wallet: pack.operatorWallet, isHouse: pack.isHouse },
    deliverBy: d.deliverBy ? iso(d.deliverBy) : null,
    undeliveredAt: d.undeliveredAt ? iso(d.undeliveredAt) : null,
    undeliveredReason: d.undeliveredReason ?? null,
  });
}

/** The explorer link of a landed payment, for the screens that show it. */
export const drawExplorerUrl = (d: Pick<DrawRow, 'txSignature' | 'cluster'>): string | null => (d.txSignature ? explorerTxUrl(d.txSignature, d.cluster as Cluster) : null);
