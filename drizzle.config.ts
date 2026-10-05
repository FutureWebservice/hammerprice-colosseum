import { config } from 'dotenv';
import type { Config } from 'drizzle-kit';

// drizzle-kit does not read .env.local like `next dev` does; a variable already in the shell still wins.
config({ path: '.env.local' });

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations run against the direct (non-pooled) endpoint; the pooler rejects DDL sessions.
  // The runtime (src/db/index.ts) uses the pooled DATABASE_URL.
  dbCredentials: { url: (process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL)! },
} satisfies Config;
