/**
 * Two complete environment fixtures, FAKE values only (nothing here is a real key, host or address).
 * Every package tests its cluster-dependent code against both.
 */
export type EnvFixture = Record<string, string>;

const FAKE_DEVNET_WALLET = '11111111111111111111111111111111'; // a valid base58 public key, used as the fake fee wallet
const FAKE_MAINNET_WALLET = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; // same, for the mainnet fixture
const CIRCLE_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // public devnet USDC mint, stands in for our test mint
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // the real mainnet USDC mint (public constant)

export const DEVNET_ENV: EnvFixture = {
  DATABASE_URL: 'postgres://user:pass@db-devnet.example.test/hp',
  SESSION_SECRET: 'fake-session-secret-devnet',
  SOLANA_CLUSTER: 'devnet',
  NEXT_PUBLIC_SOLANA_NETWORK: 'devnet',
  NEXT_PUBLIC_SOLANA_RPC_PUBLIC: 'https://api.devnet.solana.com',
  SOLANA_RPC_URL: 'https://rpc-devnet.example.test/fake',
  USDC_MINT: CIRCLE_DEVNET_MINT,
  NEXT_PUBLIC_USDC_MINT: CIRCLE_DEVNET_MINT,
  PLATFORM_WALLET_ADDRESS: FAKE_DEVNET_WALLET,
  NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: FAKE_DEVNET_WALLET,
  SETTLEMENT_AUTHORITY_SECRET_KEY: 'fake-settlement-key-devnet',
  VRF_SECRET_KEY: 'fake-vrf-key-devnet',
  HOUSE_SELLER_SECRET_KEY: 'fake-house-key-devnet',
  FAUCET_MINT_AUTHORITY_SECRET_KEY: 'fake-faucet-key-devnet',
};

export const MAINNET_ENV: EnvFixture = {
  DATABASE_URL: 'postgres://user:pass@db-mainnet.example.test/hp',
  SESSION_SECRET: 'fake-session-secret-mainnet',
  SOLANA_CLUSTER: 'mainnet-beta',
  NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta',
  NEXT_PUBLIC_SOLANA_RPC_PUBLIC: 'https://rpc-public.example.test',
  SOLANA_RPC_URL: 'https://rpc-mainnet.example.test/fake',
  PLATFORM_WALLET_ADDRESS: FAKE_MAINNET_WALLET,
  NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: FAKE_MAINNET_WALLET,
  SETTLEMENT_AUTHORITY_SECRET_KEY: 'fake-settlement-key-mainnet',
  VRF_SECRET_KEY: 'fake-vrf-key-mainnet',
};

export const MAINNET_USDC_MINT_FIXTURE = MAINNET_USDC;

/** NAME=value lines. */
export const toEnvText = (env: EnvFixture): string => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
