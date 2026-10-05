import type { Cluster } from '@/contracts';

/** The one place the explorer host is spelled. Links add `?cluster=devnet` on devnet only; mainnet is the explorer's default. */
export const explorerBase = (): string => 'https://explorer.solana.com';
const suffix = (c: Cluster) => (c === 'devnet' ? '?cluster=devnet' : '');
export const explorerTxUrl = (sig: string, c: Cluster): string => `${explorerBase()}/tx/${sig}${suffix(c)}`;
export const explorerAddressUrl = (addr: string, c: Cluster): string => `${explorerBase()}/address/${addr}${suffix(c)}`;
