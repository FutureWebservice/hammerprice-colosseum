import { configuredCluster } from '@/lib/auth/config';
import type { Cluster } from '@/contracts';
import { NAMESPACES, defaultLocale, isLocale } from './config';

type Messages = Record<string, Record<string, unknown>>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: leaves of `over` replace the leaves of `base`; objects merge; nothing is added that is not in `over`. */
export function mergeMessages<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? mergeMessages(out[k], v) : v;
  return out as T;
}

/**
 * All namespaces for a locale. A missing file or an unknown locale degrades to {} / the default
 * locale instead of throwing, so one absent JSON file never takes a page down.
 *
 * On mainnet (SOLANA_CLUSTER, the single switch) the texts in src/locales/<locale>/mainnet.json are laid over the namespaces key by key.
 * Every text of the site is written neutrally; only the few that name a network (the wallet-on-the-wrong-network help in the payment
 * sheet) differ, and they differ there. The demo hints (faucet, network line, footer line) are shown by code on devnet only.
 */
export async function loadMessages(locale: string, cluster: Cluster = configuredCluster()): Promise<Messages> {
  const l = isLocale(locale) ? locale : defaultLocale;
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => [ns, await import(`../../locales/${l}/${ns}.json`).then((m) => m.default).catch(() => ({}))] as const),
  );
  const base: Messages = Object.fromEntries(entries);
  if (cluster !== 'mainnet-beta') return base;
  const over = await import(`../../locales/${l}/mainnet.json`).then((m) => m.default).catch(() => ({}));
  return mergeMessages(base, over);
}
