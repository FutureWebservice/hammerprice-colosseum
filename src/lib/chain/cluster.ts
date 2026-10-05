/**
 * The central cluster configuration: ONE switch, `SOLANA_CLUSTER=mainnet-beta` (default devnet), and everything follows it
 * (USDC mint, RPC endpoints, explorer links, role keys, house and bot rules, and every optional feature). There is no second
 * "enable mainnet" flag and no per-feature mainnet flag.
 *
 * What stays is a CONFIGURATION SANITY check, not a legal one: with the switch on, the deployment must be completely set up for
 * mainnet, and no value may belong to the other network. If it is not, the server fails closed:
 *
 *   - `GET /api/health` answers 503 with `mainnet_config_incomplete` (something required is missing) or `cluster_config_conflict`
 *     (a value contradicts the cluster: a devnet RPC, a faucet key or a test mint on mainnet, a mainnet mint on devnet, or the
 *     server and browser cluster variables disagree), and names the variables, never a value;
 *   - every money route (bids, paddles, creating a show, settlement prepare and sign, credit purchases) answers 503 with the
 *     same code before it touches a database row or the chain (`assertClusterReady`).
 *
 * Devnet needs nothing set (its public defaults work) and is only checked for contradictions. Mainnet needs, as a minimum:
 * `SOLANA_RPC_URL`, `SETTLEMENT_AUTHORITY_SECRET_KEY`, `PLATFORM_WALLET_ADDRESS` (the fee wallet) and, while FEATURE_VRF is on,
 * `VRF_SECRET_KEY`. `USDC_MINT` may be left unset there: the mainnet mint is the default and the only accepted value.
 *
 * Pure: every function reads an env object you pass in (default process.env), so tests never touch the real environment.
 */
import { createHash } from 'node:crypto';
import { ApiError, type Cluster } from '@/contracts';
import { featureEnv } from '@/lib/features';
import {
  MAINNET_USDC_MINT, cleanEnv, cleanPublicKey, dasUrl, feeWalletAddress, resolveCluster, rpcUrlsFor, usdcMintFor,
} from './config';
import { ConfigError } from './errors';
import { explorerBase } from './explorer';
import { parseSecretKey } from './keys';

type Env = Record<string, string | undefined>;

export interface ClusterReport {
  /** null when the cluster variables themselves are unusable (unknown name, polluted value, the two variables disagree). */
  cluster: Cluster | null;
  ready: boolean;
  /** Environment variable NAMES that are required here and absent or unusable. */
  missing: string[];
  /** Environment variable NAMES whose value belongs to the other network or contradicts another variable. */
  conflicts: string[];
}

/** The role keys a cluster needs, by variable name. `VRF_SECRET_KEY` only counts while FEATURE_VRF or FEATURE_PACKS is on (a pack draw is a VRF draw). */
export function requiredRoleKeys(cluster: Cluster, env: Env = process.env): string[] {
  const base = cluster === 'mainnet-beta' ? ['SETTLEMENT_AUTHORITY_SECRET_KEY'] : [];
  return (featureEnv('VRF', env) || featureEnv('PACKS', env)) && cluster === 'mainnet-beta' ? [...base, 'VRF_SECRET_KEY'] : base;
}

const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
/** Heuristic on the host only: an RPC URL that names the other network. A URL without either word is the operator's call. */
const namesDevnet = (url: string): boolean => /devnet|testnet/.test(hostOf(url));
const namesMainnet = (url: string): boolean => /mainnet/.test(hostOf(url));

/** Runs a check that may throw ConfigError (a polluted or malformed value) and records `name` as a conflict when it does. */
function guard(conflicts: string[], name: string, check: () => void): void {
  try { check(); } catch (e) { if (!(e instanceof ConfigError)) throw e; conflicts.push(name); }
}

/**
 * Whether a role key parses. Parsing validates the key pair (a signature and a verification, a few milliseconds in the pure-JS
 * implementation) and this runs on every money request, so the answer is remembered by the SHA-256 of the value: a changed value is a
 * different entry, and the value itself is never kept.
 */
const keyChecks = new Map<string, boolean>();
function keyReadable(name: string, raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const k = `${name}:${createHash('sha256').update(raw).digest('hex')}`;
  const hit = keyChecks.get(k);
  if (hit !== undefined) return hit;
  let ok = false;
  try { parseSecretKey(name, raw); ok = true; } catch { /* unreadable counts as missing; the value is never echoed */ }
  if (keyChecks.size > 64) keyChecks.clear();
  keyChecks.set(k, ok);
  return ok;
}

/** Never throws, never reads a value into the result: names only. */
export function inspectCluster(env: Env = process.env): ClusterReport {
  const missing: string[] = [];
  const conflicts: string[] = [];

  let cluster: Cluster | null = null;
  try { cluster = resolveCluster(env); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { cluster: null, ready: false, missing, conflicts: ['SOLANA_CLUSTER', 'NEXT_PUBLIC_SOLANA_NETWORK'] };
  }
  const mainnet = cluster === 'mainnet-beta';

  // RPC endpoints: each one is a clean https URL and does not name the other network.
  for (const name of ['SOLANA_RPC_URL', 'SOLANA_RPC_FALLBACK_URLS', 'NEXT_PUBLIC_SOLANA_RPC_PUBLIC', 'DAS_RPC_URL'] as const) {
    guard(conflicts, name, () => {
      const raw = cleanEnv(name, env[name]);
      if (raw === undefined) return;
      for (const u of raw.split(',')) {
        if (!u) continue;
        let parsed: URL;
        try { parsed = new URL(u); } catch { throw new ConfigError(`${name} is not a URL`); }
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname))) throw new ConfigError(`${name} must use https`);
        if (mainnet ? namesDevnet(u) : namesMainnet(u)) throw new ConfigError(`${name} names the other network`);
      }
    });
  }

  // The mint: mainnet accepts only the real USDC mint; devnet refuses it (a mainnet mint on devnet is a copy-paste from the other set).
  for (const name of ['USDC_MINT', 'NEXT_PUBLIC_USDC_MINT'] as const) {
    guard(conflicts, name, () => {
      const v = cleanPublicKey(name, env[name]);
      if (v === undefined) return;
      if (mainnet && v !== MAINNET_USDC_MINT) throw new ConfigError(`${name} is not the mainnet USDC mint`);
      if (!mainnet && v === MAINNET_USDC_MINT) throw new ConfigError(`${name} is the mainnet USDC mint`);
    });
  }

  // The fee wallet is public; the browser copy must be the same address.
  guard(conflicts, 'PLATFORM_WALLET_ADDRESS', () => {
    const server = cleanPublicKey('PLATFORM_WALLET_ADDRESS', env.PLATFORM_WALLET_ADDRESS);
    const browser = cleanPublicKey('NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS', env.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS);
    if (server !== undefined && browser !== undefined && server !== browser) throw new ConfigError('the fee wallet differs between server and browser');
  });

  if (mainnet) {
    // The faucet mint authority exists to mint TEST USDC: a mainnet deployment holding it was set up from the devnet set.
    if (env.FAUCET_MINT_AUTHORITY_SECRET_KEY?.trim()) conflicts.push('FAUCET_MINT_AUTHORITY_SECRET_KEY');

    // A polluted value counts as "set": it is already reported as a conflict above, not as missing.
    const isSet = (read: () => string | undefined): boolean => { try { return read() !== undefined; } catch { return true; } };
    if (!isSet(() => cleanEnv('SOLANA_RPC_URL', env.SOLANA_RPC_URL))) missing.push('SOLANA_RPC_URL');
    if (!isSet(() => feeWalletAddress(env))) missing.push('PLATFORM_WALLET_ADDRESS');

    for (const name of requiredRoleKeys(cluster, env)) if (!keyReadable(name, env[name])) missing.push(name);
  }

  const uniq = (a: string[]) => [...new Set(a)];
  const m = uniq(missing), c = uniq(conflicts);
  return { cluster, ready: m.length === 0 && c.length === 0, missing: m, conflicts: c };
}

/** The reason text of a failed report, for the error body (names only). */
function describe(r: ClusterReport): string {
  if (r.conflicts.length) return `The network settings of this deployment contradict each other (${r.conflicts.join(', ')}). Nothing was sent.`;
  return `This deployment is not fully set up for ${r.cluster ?? 'its network'} yet (missing: ${r.missing.join(', ')}). Nothing was sent.`;
}

/** The ApiError a failed report becomes (503, `mainnet_config_incomplete` or `cluster_config_conflict`), or null when the report is fine. */
export function reportError(r: ClusterReport): ApiError | null {
  if (r.ready) return null;
  return new ApiError(r.conflicts.length || r.cluster === null ? 'cluster_config_conflict' : 'mainnet_config_incomplete', describe(r));
}

/**
 * Every money route and every chain write path calls this first. Throws the 503 ApiError of `reportError`, and when `cluster` is
 * given (a settlement's or a show's own cluster) also refuses a cluster other than the one this deployment serves, so a devnet
 * row can never be driven on a mainnet deployment and the other way round.
 */
export function assertClusterReady(cluster?: Cluster, env: Env = process.env): void {
  const r = inspectCluster(env);
  const e = reportError(r);
  if (e) {
    console.error('cluster configuration refuses this request:', JSON.stringify({ cluster: r.cluster, missing: r.missing, conflicts: r.conflicts })); // names only
    throw e;
  }
  if (cluster !== undefined && cluster !== r.cluster) {
    throw new ApiError('cluster_config_conflict', `This belongs to ${cluster}, but this deployment serves ${r.cluster}. Nothing was sent.`);
  }
}

export interface ClusterConfig {
  cluster: Cluster;
  mainnet: boolean;
  /** The USDC mint of the cluster: the real mint on mainnet (the default and the only accepted value), our test mint (or Circle's) on devnet. */
  usdcMint: string;
  /** RPC endpoints in failover order (the configured ones first, then the public default of the cluster). */
  rpcUrls: string[];
  dasUrl: string | undefined;
  /** `https://explorer.solana.com`; links add `?cluster=devnet` on devnet only (lib/chain/explorer.ts). */
  explorerBase: string;
  /** The fee wallet's public address; undefined when not configured (devnet may run without). */
  feeWallet: string | undefined;
}

/** The resolved values, or a ConfigError for a polluted one. Does NOT check readiness: pair it with `assertClusterReady` where money moves. */
export function clusterConfig(env: Env = process.env): ClusterConfig {
  const cluster = resolveCluster(env);
  return {
    cluster,
    mainnet: cluster === 'mainnet-beta',
    usdcMint: usdcMintFor(cluster, env),
    rpcUrls: rpcUrlsFor(cluster, env),
    dasUrl: dasUrl(env),
    explorerBase: explorerBase(),
    feeWallet: feeWalletAddress(env),
  };
}
