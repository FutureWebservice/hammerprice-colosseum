/**
 * The database client.
 *
 * WebSocket pool rather than the HTTP driver: db.transaction() throws on neon-http, and
 * closing a lot - mark sold, write the settlement, append the event - has to be one
 * transaction or a crash mid-hammer leaves a lot sold with no record of who bought it.
 *
 * This replaces a 200-line Supabase server client that carried a module-level singleton, a
 * promise race, a 10-second timeout, a 5-minute instance TTL, a cookie prefetch cache and a
 * hardcoded project ref.
 */
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import ws from 'ws';
import * as schema from './schema';
import { assertDatabaseUrl, isLocalDatabaseUrl } from './url';

// The driver needs a WebSocket implementation outside the edge runtime.
if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;

// One clean Postgres URL or a clear error that names the variable (never its value): see assertDatabaseUrl.
const connectionString = assertDatabaseUrl(process.env.DATABASE_URL);

// Module scope already gives one pool per process, so this handle is not what bounds our
// connections: each route is its own serverless bundle with its own module graph, and the real
// ceiling is (concurrently-warm routes) × (Pool max, default 10). What it buys is surviving
// `next dev`'s Fast-Refresh re-evaluation, which would otherwise strand a pool on every edit.
// Kept unconditional so both environments behave alike - this was previously guarded by
// NODE_ENV !== 'production', which read as though production were the case it mattered for and
// sent one investigation down the wrong path.
const globalForDb = globalThis as unknown as { __pool?: NeonPool | pg.Pool };

// Neon hosts go through the WebSocket pool. localhost/127.0.0.1 (local dev, CI, the embedded
// test server) has no Neon proxy to talk WebSocket to, so it uses node-postgres. Both drivers
// share the same query-builder API, so callers see one `db`; the cast only papers over the two
// driver-specific result types of `db.execute()`, which nothing here relies on.
const pool = globalForDb.__pool ?? (isLocalDatabaseUrl(connectionString)
  ? new pg.Pool({ connectionString })
  : new NeonPool({ connectionString }));
globalForDb.__pool = pool;

export const db: NeonDatabase<typeof schema> = isLocalDatabaseUrl(connectionString)
  ? (drizzlePg(pool as pg.Pool, { schema }) as unknown as NeonDatabase<typeof schema>)
  : drizzleNeon(pool as NeonPool, { schema });
export { schema };
export * from './schema';
