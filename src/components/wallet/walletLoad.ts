/**
 * The always-loaded half of the lazy wallet (WalletProvider.tsx): a few module-level handles and no wallet library at all.
 *
 * The wallet adapter, the Solana web3 client and the wallet modal weigh about 430 kB of script before compression, and most visitors of the landing
 * page, the About page or the schedule never connect a wallet. The adapter is therefore fetched on a visitor's first click or key press, at once on the
 * pages that are about a wallet (room, sell, account, packs, AI), and at once when a wallet was connected before (the adapter's autoConnect reads
 * localStorage 'walletName'). Until then the context holds an inert "not connected" value, which is exactly what the adapter reports for a visitor with
 * no wallet.
 */
import type { WalletContextState } from '@solana/wallet-adapter-react';

let start: (() => void) | null = null;
let startWanted = false;
let live: WalletContextState | null = null;
let readyWaiters: Array<() => void> = [];
let modalWanted = false;
let modalOpen: (() => void) | null = null;

/** The provider registers how to mount the lazy host. */
export function registerWalletStarter(fn: () => void): () => void {
  start = fn;
  if (startWanted) fn(); // asked for before the provider's effect ran (a child's effect runs first)
  return () => { if (start === fn) start = null; };
}

/** The lazy host reports the real wallet state on every change; the first report settles `ensureWalletHost`. */
export function reportWalletLive(ctx: WalletContextState): void {
  live = ctx;
  const w = readyWaiters;
  readyWaiters = [];
  for (const f of w) f();
}

/** The real wallet context once the host has mounted, else null. */
export const liveWallet = (): WalletContextState | null => live;

/** Starts the lazy host when it is not running yet; resolves when the real wallet state is available. */
export function ensureWalletHost(): Promise<void> {
  if (live) return Promise.resolve();
  return new Promise((resolve) => {
    readyWaiters.push(resolve);
    startWanted = true;
    start?.();
  });
}

/** Like ensureWalletHost, at a quiet moment (a first click or key press is no reason to compete with whatever the page does right then). */
export function ensureWalletHostWhenIdle(): void {
  if (live) return;
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(() => void ensureWalletHost(), { timeout: 1500 });
  else setTimeout(() => void ensureWalletHost(), 200);
}

let signInWanted = 0; // expiry (ms): a dismissed picker must not arm a sign-in for a wallet connected much later

/** "Connect, then sign in": set by a click on a wallet (or on Sign in with none connected), taken by the session once that wallet is connected (afterPick in room/walletConnect.ts). */
export function wantSignIn(on = true): void { signInWanted = on ? Date.now() + 60_000 : 0; }
export const signInIsWanted = (): boolean => Date.now() < signInWanted;

/** Opens the adapter's own wallet picker (used by "sign in" when no wallet is connected yet). */
export function openWalletModal(): void {
  modalWanted = true;
  void ensureWalletHost().then(fireModal);
}

function fireModal(): void {
  if (!modalOpen || !modalWanted) return;
  modalWanted = false;
  modalOpen();
}

/** The host's modal bridge: `open` shows the modal; a request made before the bridge existed is served at once. Returns the unbind. */
export function bindWalletModal(open: () => void): () => void {
  modalOpen = open;
  fireModal();
  return () => { if (modalOpen === open) modalOpen = null; };
}
