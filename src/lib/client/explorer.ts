/** Never guesses a network: only a known devnet adds the query; mainnet-beta and an unknown cluster (null) leave it out. */
export function explorerTxUrl(signature: string, cluster: string | null | undefined): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}
