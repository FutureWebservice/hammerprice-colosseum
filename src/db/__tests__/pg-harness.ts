/**
 * A real Postgres 18 for the integration tests: `embedded-postgres` ships the server binary as an npm package, so no Docker
 * and no Neon. The schema is the real migration chain (0000..latest).
 * Returns null (and a reason) when the server cannot start, e.g. no binary for the platform or running as root; tests then skip.
 */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

export interface TestPg {
  pool: pg.Pool;
  url: string;
  stop: () => Promise<void>;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../../drizzle');

/** Runs one drizzle .sql file statement by statement. */
export async function runSqlFile(pool: pg.Pool | pg.PoolClient, file: string): Promise<void> {
  for (const stmt of fs.readFileSync(file, 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pool.query(stmt);
}

/** All migrations in order, or only those before `upTo` (exclusive, by file name) to build the pre-migration shape. */
export function migrationFiles(upTo?: string): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().filter((f) => !upTo || f < upTo).map((f) => path.join(MIGRATIONS_DIR, f));
}

export async function startTestPg(opts: { upTo?: string; poolMax?: number } = {}): Promise<{ pg: TestPg } | { skip: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-embedded-pg-'));
  try {
    const port = await freePort();
    const server = new EmbeddedPostgres({ databaseDir: dir, user: 'hp', password: 'hp', port, persistent: false, onLog: () => {}, onError: () => {} });
    await server.initialise();
    await server.start();
    await server.createDatabase('hp');
    const url = `postgresql://hp:hp@127.0.0.1:${port}/hp`;
    const pool = new pg.Pool({ connectionString: url, max: opts.poolMax ?? 25 });
    pool.on('error', () => {}); // idle sockets see the server stop during teardown (57P01); expected
    for (const f of migrationFiles(opts.upTo)) await runSqlFile(pool, f);
    return {
      pg: {
        pool, url,
        stop: async () => { await pool.end().catch(() => {}); await server.stop().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); },
      },
    };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { skip: `embedded-postgres could not start (${(e as Error).message}); integration tests skipped` };
  }
}
