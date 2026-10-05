/**
 * The feature explainers at the bottom of the landing page: one registry, in the order they are shown.
 *
 * Words live in src/locales/{de,en}/features.json (namespace `features`). This file holds only what is not
 * words: the order, the switch a feature depends on, the deeper link and the evidence that it exists in the build.
 * The badge of a section is COMPUTED here from the deployment's environment, never written into the copy:
 *
 *   planned    the feature is not built (`built: false`); only a plan is described
 *   off        built, but not running on this deployment (switch off, a needed variable missing or malformed (Telegram and video use the
 *              feature's own validator), not available on this cluster,
 *              or the cluster is not ready: inspectCluster(env).ready is false, the same check that makes money routes answer 503)
 *   optional   running, but active only when a seller or a viewer asks for it
 *   demo       running on devnet with test content only (on mainnet the same feature is `live`)
 *   live       running end to end; the label names the cluster ("Live on devnet" or "Live on mainnet")
 *
 * Pure: every function reads an env object you pass in (default process.env), so tests never touch the real
 * environment. The landing page reads the environment only, never the database kill switches (the page is cached
 * for five minutes), so a feature switched off by the ops kill switch can show "Live" for up to five minutes.
 * SOLANA_CLUSTER is the only thing that moves a label between networks; no cluster, mint or host is written here.
 */
import { FEATURE_NAMES, featureEnv, type FeatureName } from '@/lib/features';
import { resolveCluster } from '@/lib/chain/config';
import { inspectCluster } from '@/lib/chain/cluster';
import { botConfig } from '@/server/telegram/config';
import { videoConfig } from '@/server/streams/paths';
import type { Cluster } from '@/contracts';

type Env = Record<string, string | undefined>;

export const FEATURE_IDS = [
  'settlement', 'verify', 'random', 'timed', 'room', 'chat', 'ai', 'packs', 'video', 'telegram', 'wallets', 'ideathon',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

export type FeatureStatus = 'planned' | 'off' | 'optional' | 'demo' | 'live';

export interface FeatureEntry {
  id: FeatureId;
  /** `core` always runs, `flagged` runs behind its switch, `optional` is chosen per show, `demo` is test content on devnet, `mention` has no status. */
  kind: 'core' | 'flagged' | 'optional' | 'demo' | 'mention';
  /** The FEATURE_<NAME> switch the feature depends on.  */
  flag?: FeatureName | 'TELEGRAM';
  /** Variable names that must all be set for the feature to run. */
  needsAll?: readonly string[];
  /** Variable names of which at least one must be set. */
  needsAny?: readonly string[];
  /**
   * Beyond "the names are set": the SAME validator the feature itself uses (Telegram: botConfig checks the token, username and secret
   * formats; video: videoConfig checks the host, the credentials and the ports). Both modules are pure (no I/O, no server-only import).
   * A badge therefore never says "running" for a value the feature would refuse.
   */
  valid?: (env: Env) => boolean;
  /** Format-correct throwaway values for allOnEnv, for the names whose format `valid` checks. Never a real value. */
  sample?: Readonly<Record<string, string>>;
  /** The feature exists on devnet only (it needs the platform's own test stock); on any other cluster it is `off`. */
  devnetOnly?: boolean;
  /** False while only a plan exists. A test fails when `absent` files appear, so the flip is never forgotten. */
  built: boolean;
  /** Locale-free path of the deeper place, shown only while the feature runs (a switched-off feature answers 404). */
  link?: string;
  /** Files that must exist when `built`; files that must not exist when not. Checked by a test, never at runtime. */
  evidence: { files: readonly string[]; absent?: readonly string[] };
}

export const FEATURES: readonly FeatureEntry[] = [
  {
    id: 'settlement', kind: 'core', built: true, link: '/about#how',
    evidence: { files: ['src/lib/chain/settlement-tx.ts', 'src/lib/chain/settlement-sign.ts', 'src/lib/auction/engine.ts'] },
  },
  {
    id: 'verify', kind: 'core', built: true,
    evidence: { files: ['src/lib/verify/chain.ts', 'src/app/[locale]/verify/[lotId]/page.tsx', 'src/lib/auction/bidlog.ts'] },
  },
  {
    id: 'random', kind: 'flagged', flag: 'VRF', needsAll: ['VRF_SECRET_KEY'], built: true, link: '/room/house',
    evidence: { files: ['src/lib/vrf/verify.ts', 'src/server/vrf/service.ts', 'src/app/[locale]/verify/random/[id]/page.tsx'] },
  },
  {
    id: 'timed', kind: 'flagged', flag: 'TIMED', built: true, link: '/rooms',
    evidence: { files: ['src/lib/auction/rules.ts', 'src/lib/auction/phase.ts'] },
  },
  {
    id: 'room', kind: 'core', devnetOnly: true, needsAll: ['HOUSE_SELLER_SECRET_KEY'], built: true, link: '/room/house',
    evidence: { files: ['src/lib/house-room.ts', 'src/server/house/bots.ts', 'src/app/[locale]/room/house/page.tsx'] },
  },
  {
    id: 'chat', kind: 'flagged', flag: 'CHAT', built: true, link: '/rooms',
    evidence: { files: ['src/server/chat/service.ts', 'src/server/chat/rules.ts'] },
  },
  {
    id: 'ai', kind: 'flagged', flag: 'AI', needsAny: ['GEMINI_API_KEY', 'GCP_SERVICE_ACCOUNT_JSON'], built: true, link: '/ai',
    evidence: { files: ['src/server/ai/listing.ts', 'src/server/ai/ask.ts', 'src/server/ai/faq.ts', 'src/server/ai/agent.ts'] },
  },
  {
    id: 'packs', kind: 'demo', flag: 'PACKS', needsAll: ['VRF_SECRET_KEY'], built: true, link: '/packs',
    evidence: { files: ['src/lib/chain/pack-tx.ts', 'src/lib/chain/pack-pay-tx.ts', 'src/server/packs/payfirst.ts', 'src/lib/packs/commit.ts', 'src/app/[locale]/packs/page.tsx'] },
  },
  {
    id: 'video', kind: 'optional', flag: 'VIDEO', needsAll: ['MEDIA_SERVER_URL', 'MEDIAMTX_PUBLISH_USER', 'MEDIAMTX_PUBLISH_PASS'], built: true, link: '/rooms',
    valid: (env) => videoConfig(env) !== null, sample: { MEDIA_SERVER_URL: 'media.example.org' },
    evidence: { files: ['src/server/streams/paths.ts', 'src/server/streams/mediamtx.ts'] },
  },
  {
    id: 'telegram', kind: 'flagged', flag: 'TELEGRAM', needsAll: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'], built: true,
    valid: (env) => botConfig(env) !== null,
    sample: { TELEGRAM_BOT_TOKEN: `${'1'.repeat(9)}:${'A'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'ExampleHammerBot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32) },
    evidence: { files: ['src/server/telegram/service.ts', 'src/server/telegram/bot.ts', 'src/app/api/telegram/webhook/route.ts'] },
  },
  {
    id: 'wallets', kind: 'core', built: true, link: '/about#faq',
    evidence: { files: ['src/components/room/wallets.ts', 'src/lib/chain/settlement-tx.ts'] },
  },
  { id: 'ideathon', kind: 'mention', built: true, evidence: { files: [] } },
];

const isSet = (env: Env, name: string): boolean => (env[name] ?? '').trim() !== '';

/** The cluster of this deployment, or null when the cluster variables are unusable or contradict each other. */
export function clusterOf(env: Env = process.env): Cluster | null {
  try {
    return resolveCluster(env);
  } catch {
    return null;
  }
}

/** Whether the environment switch of a feature is on (exactly "true", like lib/features). */
export function flagOn(flag: NonNullable<FeatureEntry['flag']>, env: Env = process.env): boolean {
  return (FEATURE_NAMES as readonly string[]).includes(flag) ? featureEnv(flag as FeatureName, env) : env[`FEATURE_${flag}`] === 'true';
}

/** The badge of one section for one deployment. `null` for an entry that is only a mention. */
export function featureStatus(entry: FeatureEntry, env: Env = process.env): FeatureStatus | null {
  if (entry.kind === 'mention') return null;
  if (!entry.built) return 'planned';
  const cluster = clusterOf(env);
  if (cluster === null) return 'off';
  if (!inspectCluster(env).ready) return 'off';
  if (entry.devnetOnly && cluster !== 'devnet') return 'off';
  if (entry.flag && !flagOn(entry.flag, env)) return 'off';
  if (entry.needsAll?.some((n) => !isSet(env, n))) return 'off';
  if (entry.needsAny && !entry.needsAny.some((n) => isSet(env, n))) return 'off';
  if (entry.valid && !entry.valid(env)) return 'off';
  if (entry.kind === 'optional') return 'optional';
  if (entry.kind === 'demo' && cluster === 'devnet') return 'demo';
  return 'live';
}

/** The locale key of the badge text, `status.<key>` in features.json. Only `live` depends on the cluster. */
export function statusKey(status: FeatureStatus, cluster: Cluster | null): string {
  if (status !== 'live') return status;
  return cluster === 'mainnet-beta' ? 'liveMainnet' : 'liveDevnet';
}

/** The deeper link, only while the feature is running. */
export const linkOf = (entry: FeatureEntry, status: FeatureStatus | null): string | null =>
  entry.link && (status === 'live' || status === 'demo' || status === 'optional') ? entry.link : null;

/**
 * An environment in which every BUILT feature runs on the given cluster: its switch on and every variable it needs set (to a
 * placeholder, never a real value). On mainnet the cluster must also be ready (RPC, fee wallet, readable keys: see inspectCluster), which the caller adds. It is what the tests use as the "all on" case.
 */
export function allOnEnv(cluster: Cluster = 'devnet'): Record<string, string> {
  const env: Record<string, string> = { SOLANA_CLUSTER: cluster };
  for (const f of FEATURES) {
    if (!f.built) continue;
    if (f.flag) env[`FEATURE_${f.flag}`] = 'true';
    for (const n of f.needsAll ?? []) env[n] = 'set';
    if (f.needsAny?.[0]) env[f.needsAny[0]] = 'set';
    Object.assign(env, f.sample);
  }
  return env;
}
