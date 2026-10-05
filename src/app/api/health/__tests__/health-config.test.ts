/**
 * /api/health fails closed on an unusable cluster configuration, before it touches the database: 503, a code, and variable NAMES only.
 * (The healthy path needs a database and is covered by the integration suites.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HealthConfigErrorResponse } from '@/contracts';

const KEYS = ['SOLANA_CLUSTER', 'NEXT_PUBLIC_SOLANA_NETWORK', 'SOLANA_RPC_URL', 'SETTLEMENT_AUTHORITY_SECRET_KEY', 'PLATFORM_WALLET_ADDRESS', 'USDC_MINT', 'FAUCET_MINT_AUTHORITY_SECRET_KEY'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const setEnv = (env: Record<string, string | undefined>) => { for (const k of KEYS) delete process.env[k]; for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v; };

describe('GET /api/health with an unusable cluster configuration', () => {
  it('SOLANA_CLUSTER=mainnet-beta without its RPC, key and fee wallet: 503 mainnet_config_incomplete, names only', async () => {
    setEnv({ SOLANA_CLUSTER: 'mainnet-beta' });
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('x-health-status')).toBe('misconfigured');
    const body = HealthConfigErrorResponse.parse(await res.json());
    expect(body).toMatchObject({ ok: false, code: 'mainnet_config_incomplete', cluster: 'mainnet-beta', conflicts: [] });
    expect(body.missing.sort()).toEqual(['PLATFORM_WALLET_ADDRESS', 'SETTLEMENT_AUTHORITY_SECRET_KEY', 'SOLANA_RPC_URL']);
  });

  it('a devnet value on mainnet is a conflict, and the two cluster variables disagreeing is one too', async () => {
    const { GET } = await import('../route');
    setEnv({ SOLANA_CLUSTER: 'mainnet-beta', SOLANA_RPC_URL: 'https://api.devnet.solana.com', FAUCET_MINT_AUTHORITY_SECRET_KEY: '[1,2,3]' });
    let body = HealthConfigErrorResponse.parse(await (await GET()).json());
    expect(body.code).toBe('cluster_config_conflict');
    expect(body.conflicts.sort()).toEqual(['FAUCET_MINT_AUTHORITY_SECRET_KEY', 'SOLANA_RPC_URL']);
    setEnv({ SOLANA_CLUSTER: 'devnet', NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' });
    const res = await GET();
    expect(res.status).toBe(503);
    body = HealthConfigErrorResponse.parse(await res.json());
    expect(body).toMatchObject({ code: 'cluster_config_conflict', cluster: null });
  });
});
