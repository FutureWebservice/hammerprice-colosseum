/**
 * Collector Crypt - the vault the catalogue is drawn from.
 *
 * Public, unauthenticated, read-only. North of 140,000 graded cards live in it today (the
 * API answers the exact figure as `total`, which the landing page shows), each one an
 * on-chain asset held in its owner's own wallet. We never take custody of any of them; we
 * only read the catalogue. Settlement is our own co-signed transaction (src/lib/chain), not Collector Crypt's marketplace program.
 *
 * Two things the API demands and will not tell you:
 *  - send a User-Agent, or the WAF answers 403 with an empty body;
 *  - paginate with `nextCursor`, never `page=N`.
 */

// `||`, not `??`: an empty COLLECTOR_CRYPT_API in .env.local (a copied template line) must fall back to the default instead of breaking every catalogue read.
const BASE = process.env.COLLECTOR_CRYPT_API?.trim() || 'https://api.collectorcrypt.com';
const UA = 'hammerprice/0.1 (+https://hammerprice-earn.vercel.app)';

export interface VaultCard {
  id: string;
  /** The on-chain asset. This is what actually moves at settlement. */
  nftAddress: string;
  /** 'core' (Metaplex Core) or 'pnft' - decides which settlement instruction applies. */
  nftStandard: string;
  /** e.g. "2021 #4 Charizard PSA 9 Celebrations Ultra-Premium Collection". */
  name: string;
  /** The set the card belongs to, where the vault records one. */
  set: string | null;
  /** Which vault physically holds it - OmniVault, PWCC. */
  vault: string | null;
  category: string | null;
  gradingCompany: string | null;
  grade: string | null;
  gradingId: string | null;
  /** Vault operator's declared insured value, in USD. Not a price. */
  insuredValue: number | null;
  /** Present only while the owner has it listed. */
  price: number | null;
  currency: string | null;
  ownerWallet: string | null;
  images: { front?: string; back?: string };
}

interface Page {
  cards: VaultCard[];
  nextCursor: string | null;
  total: number;
}

/** The fields of the vault's card JSON that are read here; the API sends more. */
interface RawCard {
  id: string | number;
  nftAddress: string;
  nftStandard?: string;
  blockchain?: string;
  itemName?: string;
  category?: string;
  gradingID?: string;
  set?: string;
  vault?: string;
  gradingCompany?: string;
  grade?: string;
  insuredValue?: unknown;
  listing?: { price?: number | string | null; currency?: string };
  owner?: { wallet?: string };
  images?: { front?: string; back?: string; frontS?: string; backS?: string };
}

interface RawPage {
  filterNFtCard?: RawCard[];
  nextCursor?: string | null;
  total?: number;
}

function toCard(raw: RawCard): VaultCard {
  return {
    id: String(raw.id),
    nftAddress: raw.nftAddress,
    nftStandard: raw.nftStandard ?? 'unknown',
    name: raw.itemName ?? `${raw.category ?? 'Card'} ${raw.gradingID ?? ''}`.trim(),
    set: raw.set ?? null,
    vault: raw.vault ?? null,
    category: raw.category ?? null,
    gradingCompany: raw.gradingCompany ?? null,
    grade: raw.grade ?? null,
    gradingId: raw.gradingID ?? null,
    insuredValue: typeof raw.insuredValue === 'number' ? raw.insuredValue : null,
    price: raw.listing?.price != null ? Number(raw.listing.price) : null,
    currency: raw.listing?.currency ?? null,
    ownerWallet: raw.owner?.wallet ?? null,
    images: { front: raw.images?.frontS ?? raw.images?.front, back: raw.images?.backS ?? raw.images?.back },
  };
}

async function get(path: string, params: Record<string, string | number | undefined>): Promise<RawPage> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    // The catalogue is not per-user; let the edge hold it briefly.
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`collector-crypt ${res.status} on ${path}`);
  return (await res.json()) as RawPage;
}

/** One page of the marketplace catalogue. `step` is the page size, not an offset. */
export async function listCards(opts: { step?: number; cursor?: string; category?: string } = {}): Promise<Page> {
  const d = await get('/marketplace', {
    step: opts.step ?? 24,
    orderBy: 'listedDateDesc',
    cursor: opts.cursor,
    // Collector Crypt's /marketplace rejects `category` (400 "property category should not
    // exist") - the real upstream param is plural. Our own listCards() option name stays
    // `category` since that's this module's public contract; only the wire param changes.
    categories: opts.category,
  });
  return {
    cards: (d.filterNFtCard ?? []).map(toCard),
    nextCursor: d.nextCursor ?? null,
    total: d.total ?? 0,
  };
}

/**
 * Everything a given wallet holds in the vault, listed or not: the seller's lot picker. Only Solana Metaplex Core cards
 * are returned (pNFT, cNFT and EVM cards cannot be consigned yet).
 *
 * `/marketplace?owner=` answers HTTP 400 ("property owner should not exist"); `GET /cards/<wallet>` is the public
 * endpoint that returns every card of a wallet, including unlisted ones.
 */
export async function listByOwner(wallet: string): Promise<VaultCard[]> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error('not a wallet address');
  const d = await get(`/cards/${wallet}`, {});
  return (d.filterNFtCard ?? [])
    .filter((raw) => raw.blockchain === 'Solana' && raw.nftStandard === 'core')
    .map(toCard);
}

export const explorerUrl = (mint: string) => `https://solscan.io/token/${mint}`;
