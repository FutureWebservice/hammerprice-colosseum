/**
 * Facts about the site that more than one page, the sitemap or a document repeats, written once.
 * Pure constants, no imports, so middleware-free code, tests and the metadata routes can all read it.
 *
 * Nothing here is invented: the operator and contact come from the owner's decisions, the
 * ideathon line is the owner's exact wording (never a rank, never "won"), and the GitHub
 * organisation is the owner of this repository's `origin` remote.
 */
import type { Locale } from '@/lib/i18n/config';

// No production domain exists yet; the alias is the closest thing to a live URL and
// NEXT_PUBLIC_SITE_URL overrides it once a domain does. Same default as [locale]/layout.tsx.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://hammerprice-earn.vercel.app').replace(/\/+$/, '');
export const SITE_NAME = 'Hammerprice';

export const OPERATOR_NAME = 'Future Webservice';
export const FOUNDER = { name: 'Farshad Shadjari', role: 'Founder' } as const;
/** The one mailbox. When src/legal/config.ts lands, its CONTACT_EMAIL is the same value. */
export const CONTACT_EMAIL = 'info@futurewebservice.de';
/** The organisation that owns the repository's origin remote. */
export const GITHUB_ORG_URL = 'https://github.com/FutureWebservice';

/** The owner's exact wording. Never a rank, never "won", and nothing quoted from the jury. */
export const IDEATHON_LINE: Record<Locale, string> = {
  en: "One of ten prize winners at Superteam Germany's Road to Colosseum Ideathon",
  de: 'Einer von zehn Preisträgern beim Road-to-Colosseum-Ideathon von Superteam Germany',
};

/** Install pages for the three wallets the room supports through the Wallet Standard. */
export const WALLET_LINKS = [
  { id: 'phantom', name: 'Phantom', href: 'https://phantom.com/download' },
  { id: 'solflare', name: 'Solflare', href: 'https://solflare.com/download' },
  { id: 'backpack', name: 'Backpack', href: 'https://backpack.app/downloads' },
] as const;

/**
 * The vault count as a sentence of copy. The live figure is read from Collector Crypt wherever a
 * page can (landing, pitch); everywhere the copy is static it says this floor, so the numbers on
 * the site never disagree. Raise it only when the live figure is comfortably above the new value.
 */
export const VAULT_FLOOR = 150_000;

const LOCALE_TAG: Record<Locale, string> = { en: 'en-US', de: 'de-DE' };

/** "159,184" in English, "159.184" in German. One formatter so no page hand-rolls toLocaleString. */
export function formatCount(n: number, locale: Locale): string {
  return n.toLocaleString(LOCALE_TAG[locale]);
}

/**
 * A dollar amount as a locale-correct USD string with exactly two decimals: "$1,091.00" in
 * English, "1.091,00 $" in German. Money is never shown with fewer or more than cents.
 */
export function formatUsd(n: number, locale: Locale): string {
  return n.toLocaleString(LOCALE_TAG[locale], { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "150,000" / "150.000". */
export const vaultFloorLabel = (locale: Locale): string => formatCount(VAULT_FLOOR, locale);

/**
 * USDC base units (6 dp, a decimal string as the API sends it) as a locale-correct USD string with
 * two decimals. Integer math on cents, never a float division of the raw value. '' when absent or invalid.
 */
export function formatUsdcUnits(units: string | null | undefined, locale: Locale): string {
  if (units == null || units === '') return '';
  let n: bigint;
  try {
    n = BigInt(units);
  } catch {
    return '';
  }
  const neg = n < BigInt(0);
  const cents = Number((neg ? -n : n) / BigInt(10_000)); // 1 cent = 10,000 base units, truncated
  return formatUsd((neg ? -cents : cents) / 100, locale);
}
