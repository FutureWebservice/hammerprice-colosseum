import { sql } from 'drizzle-orm';
import { configuredCluster } from '@/lib/auth/config';
import { json, fail } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { readFlags } from '@/app/api/auctions/_shared/flags';
import { getDb } from '@/app/api/auctions/_shared/http';
import { inspectCluster, reportError } from '@/lib/chain/cluster';
import { chainProbe } from './probe';

/** Reads nothing from the request, so say outright that it is never rendered at build time. */
export const dynamic = 'force-dynamic';

const timed = async <T,>(f: () => Promise<T>): Promise<{ ms: number; value: T | null }> => {
  const t = performance.now();
  const value = await f().catch(() => null);
  return { ms: Math.round(performance.now() - t), value };
};

/**
 * Is it up, and is it funded. 503 with `mainnet_config_incomplete` or `cluster_config_conflict` while the cluster configuration is not usable (contracts/api.ts HealthConfigErrorResponse). Otherwise always 200 while the database answers (a dead RPC or an unreadable settlement authority is
 * "degraded", not "down": `sa.sol` is null and the `x-health-status` header says degraded); 503 only when the database is down.
 * It also keeps the database compute awake (the warm workflow calls it). Nothing here is secret: a balance rounded down to 0.1 SOL, a cluster, switch states. The chain half is memoised (probe.ts).
 */
export const GET = route(async () => {
  // Fail closed before anything else: an incomplete or contradictory cluster configuration (SOLANA_CLUSTER=mainnet-beta without its RPC,
  // keys or fee wallet, a devnet value on mainnet or the reverse) is a 503 with the variable NAMES, and the money routes refuse as well.
  const report = inspectCluster();
  const problem = reportError(report);
  if (problem) {
    return json(
      { ok: false, code: problem.code, reason: problem.message, cluster: report.cluster, missing: report.missing, conflicts: report.conflicts },
      'none',
      { status: problem.status, headers: { 'x-health-status': 'misconfigured' } },
    );
  }
  const db = await getDb();
  const dbPing = await timed(() => db.execute(sql`select 1`));
  if (dbPing.value === null) return fail('paused', 'The database is not answering');

  const cluster = configuredCluster();
  const rpc = await chainProbe(cluster);
  const flags = await readFlags();
  return json(
    { ok: true, db: { ms: dbPing.ms }, rpc: { ms: rpc.ms }, cluster, sa: { sol: rpc.sol }, flags },
    'none',
    { headers: { 'x-health-status': rpc.sol === null ? 'degraded' : 'ok' } },
  );
});
