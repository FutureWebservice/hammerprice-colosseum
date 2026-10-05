/** Network facts the seller and account pages need in the browser. Inlined at build time by Next. */
const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? '';
/** Devnet unless the build says mainnet. The devnet helpers (test cards, test USDC) answer 404 anywhere else. */
export const IS_DEVNET = !/^mainnet/.test(NETWORK);

const suffix = IS_DEVNET ? '?cluster=devnet' : '';
export const txUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}${suffix}`;
export const addressUrl = (address: string) => `https://explorer.solana.com/address/${address}${suffix}`;

/** "3Cv8…dwiU": enough to recognise a wallet or mint without printing 44 characters. */
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
