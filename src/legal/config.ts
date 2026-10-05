/**
 * The ONE legal config. Every operator fact, region, fee and notice that the
 * legal pages, the footer and the privacy text print comes from this file. The markdown under
 * src/legal/content only contains {{PLACEHOLDERS}}; nothing is typed twice.
 *
 * Pure and dependency-free (no fs, no React), so the client footer can import it. Env values that
 * exist only on the server (PLATFORM_FEE_BPS, SETTLEMENT_WINDOW_S) fall back to the code defaults in
 * the browser, which is harmless: the client only uses the network notice and the operator name.
 *
 * Anything that cannot be known from the code is `null` here and shows up in
 * UNRESOLVED. `assertLegalReady()` (content.ts) throws on a production deployment while UNRESOLVED is
 * not empty, so a page with a hole in it can never ship. Never fill a value in to make that go away
 * unless it is true.
 */
import { locales } from '@/lib/i18n/config';
import type { Locale } from '@/lib/i18n/config';

export const OPERATOR = {
  name: 'Future Webservice',
  owner: 'Farshad Shadjari',
  /** Verbatim. Whether a c/o address is a "ladungsfähige Anschrift" is a lawyer question (not reviewed by a lawyer). */
  addressLines: ['c/o Autorenglück #78416', 'Albert-Einstein-Straße 47', '02977 Hoyerswerda', 'Deutschland'],
  /** The one mailbox. Also the DSA and privacy contact: no aliases are invented. */
  email: 'info@futurewebservice.de',
} as const;

/** Facts that are the same in every environment. `null` = cannot be known from here, see UNRESOLVED. */
const FACTS = {
  version: '1.2',
  /** ISO date of this version of the texts. Bump with VERSION on every change. */
  lastUpdated: '2026-10-04',
  jurisdictionCity: 'Hoyerswerda',
  /** Section 3.1 of the privacy text. Depends on the Vercel plan; nobody has checked it. */
  // Vercel Hobby plan (checked 2026-10-01): runtime logs are kept for about one hour. Update when the plan changes.
  logRetention: { de: 'Die Laufzeit-Logs von Vercel werden bei dem von uns genutzten Tarif (Hobby) etwa eine Stunde lang vorgehalten', en: 'Vercel runtime logs are kept for about one hour on the plan we use (Hobby)' } as Record<Locale, string> | null,
  /** `{ date, firm }` once counsel has reviewed the texts. Optional: it only changes the status line on the legal index. */
  legalReview: null as { date: string; firm: string } | null,
};

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DE_MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export function formatDate(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split('-').map(Number);
  return locale === 'de' ? `${d}. ${DE_MONTHS[m - 1]} ${y}` : `${d} ${EN_MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------------------------
// Network mode (NEXT_PUBLIC_SOLANA_NETWORK)
// ---------------------------------------------------------------------------------------------

export type NetworkMode = 'devnet' | 'mainnet';

/** `null` = set to something we do not know. Unset or empty means devnet (the dev default). */
export function parseNetwork(raw: string | undefined): NetworkMode | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'devnet') return 'devnet';
  if (v === 'mainnet' || v === 'mainnet-beta') return 'mainnet';
  return null;
}

const NETWORK_NOTICE: Record<NetworkMode, Record<Locale, string>> = {
  devnet: {
    de: '**Demonstrationsbetrieb.** Hammerprice läuft derzeit als Live-Beta im Testnetz (Solana Devnet), als Vorführung im Rahmen eines Hackathons. Token und Guthaben im Testnetz haben keinen Wert. Es werden keine Zahlungen mit echtem Geld ausgeführt und keine echten Karten übertragen. Ein Start im Hauptnetz ist nach dem Hackathon geplant, aber nicht zugesagt.',
    en: '**Demonstration mode.** Hammerprice currently runs as a live beta on the test network (Solana devnet), as a demonstration within a hackathon. Tokens and balances on the test network have no value. No payments with real money are executed and no real cards change hands. A launch on the main network is planned after the hackathon but is not promised.',
  },
  mainnet: { de: '', en: '' },
};

/** What the browser sees: the public variable is inlined at build time, so server and client agree. */
export const NETWORK_MODE: NetworkMode = parseNetwork(process.env.NEXT_PUBLIC_SOLANA_NETWORK) ?? 'devnet';

/** The demonstration notice as markdown (empty on mainnet). */
export function networkNotice(locale: Locale, mode: NetworkMode = NETWORK_MODE): string {
  return NETWORK_NOTICE[mode][locale];
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export interface Unresolved {
  key: string;
  reason: string;
}

/** The env values this config reads. Passed in so tests can pose as production. */
export interface LegalEnv {
  NEXT_PUBLIC_SOLANA_NETWORK?: string;
  NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS?: string;
  PLATFORM_FEE_BPS?: string;
  SETTLEMENT_WINDOW_S?: string;
}

export type PlaceholderValues = Record<string, string>;

export interface ResolvedLegalConfig {
  mode: NetworkMode;
  feeBps: number;
  settlementWindowMinutes: number;
  values: Record<Locale, PlaceholderValues>;
  unresolved: Unresolved[];
}

/** Same rule as the engine: an empty or invalid value falls back to 250, never 0 (.env.example). */
function parseFeeBps(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 && n < 10_000 ? n : 250;
}

/** Same rule as SETTLEMENT_WINDOW_S in .env.example: seconds, default 900. */
function parseWindowMinutes(raw: string | undefined): number {
  const n = Number(raw);
  const seconds = raw && Number.isInteger(n) && n > 0 ? n : 900;
  return Math.max(1, Math.round(seconds / 60));
}

function formatPercent(bps: number, locale: Locale): string {
  const p = bps / 100;
  const s = Number.isInteger(p) ? String(p) : String(Number(p.toFixed(2)));
  return locale === 'de' ? `${s.replace('.', ',')} %` : `${s}%`;
}

const TEXT = {
  hosting: { de: 'Vercel, USA (Funktionen in iad1, weltweites CDN)', en: 'Vercel, USA (functions iad1, global CDN)' },
  database: { de: 'Neon, AWS us-east-1 (USA)', en: 'Neon, AWS us-east-1 (USA)' },
  vat: {
    de: 'Kleinunternehmer gemäß § 19 UStG. Es wird keine Umsatzsteuer ausgewiesen.',
    en: 'Small business within the meaning of Section 19 UStG (German VAT Act). No VAT is charged.',
  },
  vsbg: {
    de: 'Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',
    en: 'We are neither willing nor obliged to take part in dispute resolution proceedings before a consumer arbitration board.',
  },
  review: {
    de: 'Diese Texte wurden sorgfältig auf Grundlage der geltenden Gesetze und der Leitlinien der Aufsichtsbehörden erstellt. Sie wurden nicht anwaltlich geprüft und sind keine Rechtsberatung.',
    en: 'These texts were carefully prepared on the basis of current law and supervisory guidance. They have not been reviewed by a lawyer and are not legal advice.',
  },
  networkFee: {
    devnet: {
      de: 'Im Testnetz übernimmt die Abwicklungsstelle von Hammerprice die Netzwerkgebühren. Käufer und Verkäufer brauchen dafür kein SOL.',
      en: 'On the test network the Hammerprice settlement authority pays the network fees. Buyers and sellers need no SOL for them.',
    },
    mainnet: {
      de: 'Im Hauptnetz übernimmt die Abwicklungsstelle von Hammerprice die Netzwerkgebühren und die Kontomiete, genau wie im Testnetz. Käufer und Verkäufer brauchen dafür kein SOL.',
      en: 'On the main network the Hammerprice settlement authority pays the network fees and the account rent, as it does on the test network. Buyers and sellers need no SOL for them.',
    },
  },
};

/** Shown in place of a value nobody knows. content.ts refuses to render any page containing it in production. */
export const TBD = (key: string) => `[TBD: ${key}]`;

export function resolveConfig(env: LegalEnv): ResolvedLegalConfig {
  const unresolved: Unresolved[] = [];
  const parsedMode = parseNetwork(env.NEXT_PUBLIC_SOLANA_NETWORK);
  if (parsedMode === null || !(env.NEXT_PUBLIC_SOLANA_NETWORK ?? '').trim()) {
    unresolved.push({ key: 'NETWORK_MODE', reason: 'SOLANA_CLUSTER (which fills NEXT_PUBLIC_SOLANA_NETWORK at build time) must be set to devnet or mainnet-beta (the demonstration notice depends on it)' });
  }
  const mode: NetworkMode = parsedMode ?? 'devnet';

  const wallet = (env.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS ?? '').trim();
  if (!wallet) unresolved.push({ key: 'TREASURY_WALLET', reason: 'NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS is empty; the fees page must print the real fee address' });
  if (!FACTS.logRetention) unresolved.push({ key: 'LOG_RETENTION', reason: 'server log retention depends on the Vercel plan and has not been checked (privacy text 3.1)' });
  // No counsel-review gate on mainnet: the one switch is SOLANA_CLUSTER, and the
  // only mainnet check is configuration sanity (lib/chain/cluster.ts). `legalReview` stays an optional fact for the status line below.

  const feeBps = parseFeeBps(env.PLATFORM_FEE_BPS);
  const settlementWindowMinutes = parseWindowMinutes(env.SETTLEMENT_WINDOW_S);

  const values = Object.fromEntries(
    locales.map((locale): [Locale, PlaceholderValues] => {
      const review = FACTS.legalReview
        ? locale === 'de'
          ? `Anwaltlich geprüft am ${formatDate(FACTS.legalReview.date, locale)} von ${FACTS.legalReview.firm}.`
          : `Reviewed by counsel on ${formatDate(FACTS.legalReview.date, locale)} by ${FACTS.legalReview.firm}.`
        : TEXT.review[locale];
      return [
        locale,
        {
          OPERATOR_NAME: OPERATOR.name,
          OPERATOR_OWNER: OPERATOR.owner,
          OPERATOR_ADDRESS: OPERATOR.addressLines.join('\n'),
          CONTACT_EMAIL: OPERATOR.email,
          DSA_CONTACT_EMAIL: OPERATOR.email,
          PRIVACY_CONTACT_EMAIL: OPERATOR.email,
          // Electronic contact is the owner's decision (A4): no phone, no W-IdNr. Empty = the line disappears.
          PHONE_OPTIONAL: '',
          W_IDNR_LINE: '',
          VAT_ID_OR_KLEINUNTERNEHMER: TEXT.vat[locale],
          VSBG_STATEMENT: TEXT.vsbg[locale],
          VERSION: FACTS.version,
          LAST_UPDATED: formatDate(FACTS.lastUpdated, locale),
          JURISDICTION_CITY: FACTS.jurisdictionCity,
          PLATFORM_FEE_PERCENT: formatPercent(feeBps, locale),
          TREASURY_WALLET: wallet || TBD('TREASURY_WALLET'),
          NETWORK_FEE_TEXT: TEXT.networkFee[mode][locale],
          SETTLEMENT_WINDOW_MINUTES: String(settlementWindowMinutes),
          HOSTING_REGION: TEXT.hosting[locale],
          DB_REGION: TEXT.database[locale],
          LOG_RETENTION: FACTS.logRetention?.[locale] ?? TBD('LOG_RETENTION'),
          LEGAL_REVIEW_STATUS_LINE: review,
          NETWORK_MODE_NOTICE: networkNotice(locale, mode),
        },
      ];
    }),
  ) as Record<Locale, PlaceholderValues>;

  return { mode, feeBps, settlementWindowMinutes, values, unresolved };
}

/**
 * The real config for this process. Literal `process.env.X` reads so the bundler can inline the
 * public ones.
 */
export const LEGAL = resolveConfig({
  NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK,
  NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS: process.env.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS,
  PLATFORM_FEE_BPS: process.env.PLATFORM_FEE_BPS,
  SETTLEMENT_WINDOW_S: process.env.SETTLEMENT_WINDOW_S,
});

/** Everything that is not known yet. Empty means the legal pages may go live. */
export const UNRESOLVED: readonly Unresolved[] = LEGAL.unresolved;
