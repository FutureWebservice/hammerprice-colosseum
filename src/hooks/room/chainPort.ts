/**
 * The one seam to CHAIN's validator. The room never asks a wallet to sign a settlement transaction that
 * this byte-exact check has not accepted; tests inject their own double through `signRound`'s `assertTx`.
 */
export { assertSettlementTx } from '@/lib/chain/settlement-tx';
