/**
 * Loads ONLY what the chain scripts need from .env.local: the database URL (for devnet_assets) and optional devnet overrides.
 * The rest of .env.local (legacy Supabase names, tokens) is deliberately not loaded. Nothing is printed.
 */
import fs from 'node:fs';
import { parse } from 'dotenv';

const PRODUCTION_DB_FRAGMENT = 'ep-production-example';
const WANTED = ['DATABASE_URL', 'DEVNET_RPC_URL', 'HP_PUBLIC_URL', 'HP_KEYS_FILE', 'COLLECTOR_CRYPT_API'];

export function loadScriptEnv(file = '.env.local'): void {
  if (!fs.existsSync(file)) return;
  const parsed = parse(fs.readFileSync(file));
  for (const k of WANTED) if (parsed[k] && process.env[k] === undefined) process.env[k] = parsed[k]!.trim();
  // A polluted value would break `new URL` inside the vault client; drop it and let the default apply.
  if (process.env.COLLECTOR_CRYPT_API && /[\s#]/.test(process.env.COLLECTOR_CRYPT_API)) delete process.env.COLLECTOR_CRYPT_API;
}

/** Refuses production. Never prints the URL. */
export function assertNotProductionDb(): void {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error('DATABASE_URL is not set');
  if (u.includes(PRODUCTION_DB_FRAGMENT)) throw new Error('refusing to run: DATABASE_URL points at the production database');
}
