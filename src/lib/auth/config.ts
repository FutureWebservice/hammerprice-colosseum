/**
 * Which Solana cluster this deployment serves. Pure, so the browser (WalletProvider) and the server
 * (bid intents, login) read the same rule. Anything unrecognised means devnet: a typo in an env value
 * must never turn a demo build into a mainnet one.
 */
import type { Cluster } from '@/contracts';

export function normalizeCluster(value: string | null | undefined): Cluster {
  const v = value?.trim().toLowerCase();
  return v === 'mainnet-beta' || v === 'mainnet' ? 'mainnet-beta' : 'devnet';
}

/** Server side: SOLANA_CLUSTER first, then the public mirror. The browser passes NEXT_PUBLIC_SOLANA_NETWORK to normalizeCluster itself. */
export function configuredCluster(env: Record<string, string | undefined> = process.env): Cluster {
  return normalizeCluster(env.SOLANA_CLUSTER || env.NEXT_PUBLIC_SOLANA_NETWORK);
}

const PUBLIC_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

/**
 * The RPC endpoint the browser wallet adapter reads from: `configured` (NEXT_PUBLIC_SOLANA_RPC_PUBLIC) when
 * it is one clean https URL, otherwise the public endpoint of the cluster. A value with a stray space or
 * trailing comment once shipped in production and broke every read; it falls back instead.
 */
export function rpcEndpoint(cluster: Cluster, configured?: string | null): string {
  const v = configured?.trim();
  if (v && !/\s/.test(v)) {
    try {
      if (new URL(v).protocol === 'https:') return v;
    } catch { /* fall through to the public endpoint */ }
  }
  return PUBLIC_RPC[cluster];
}
