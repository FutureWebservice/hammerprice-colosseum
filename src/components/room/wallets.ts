/**
 * The wallet list for people who have none installed, and the phone deep links that open this page inside a
 * wallet's own browser. Pure; the sheet feeds it what the wallet adapter detected.
 */
export interface KnownWallet { id: 'phantom' | 'solflare' | 'backpack'; name: string; install: string }

export const KNOWN_WALLETS: readonly KnownWallet[] = [
  { id: 'phantom', name: 'Phantom', install: 'https://phantom.app/download' },
  { id: 'solflare', name: 'Solflare', install: 'https://solflare.com/download' },
  { id: 'backpack', name: 'Backpack', install: 'https://backpack.app/download' },
];

export interface DetectedWallet { name: string; installed: boolean }
export interface WalletRow { id: string; name: string; installed: boolean; install: string | null }

/** The three known wallets first (installed or not), then any other wallet the browser announced. */
export function walletRows(detected: readonly DetectedWallet[]): WalletRow[] {
  const rows: WalletRow[] = KNOWN_WALLETS.map((k) => {
    const hit = detected.find((d) => d.name.toLowerCase().includes(k.id));
    return { id: k.id, name: hit?.name ?? k.name, installed: !!hit?.installed, install: k.install };
  });
  for (const d of detected) {
    if (d.installed && !KNOWN_WALLETS.some((k) => d.name.toLowerCase().includes(k.id))) rows.push({ id: d.name, name: d.name, installed: true, install: null });
  }
  return rows;
}

/**
 * Universal links that open `url` inside the wallet app's in-app browser. Documented by Phantom and Solflare;
 * Backpack has no link here, only its install page. `origin` is the `ref` the wallets ask for.
 */
export function mobileLinks(url: string, origin: string): Array<{ id: 'phantom' | 'solflare'; name: string; href: string }> {
  const u = encodeURIComponent(url);
  const ref = encodeURIComponent(origin);
  return [
    { id: 'phantom', name: 'Phantom', href: `https://phantom.app/ul/browse/${u}?ref=${ref}` },
    { id: 'solflare', name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
  ];
}

export const isMobileUa = (ua: string): boolean => /Android|iPhone|iPad|iPod/i.test(ua);
