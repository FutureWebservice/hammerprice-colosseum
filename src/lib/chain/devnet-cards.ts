/**
 * The devnet demo cards. `CARD_TEMPLATES` are real Collector Crypt vault cards (name, grade, grader, cert, set and the real
 * photo on the vault CDN), copied from the public catalogue. A replica is a
 * Hammerprice test asset that names the real card it copies (`replica_of`) and says so in its label; it is never presented as
 * the real card. Pure data and helpers: no I/O.
 */
export const REPLICA_LABEL = 'Devnet replica: a Hammerprice test asset, not a real card';
export const REPLICA_SUFFIX = ' (devnet replica)';
export const CARD_SYMBOL = 'HPCARD';

export interface CardTemplate {
  id: string;
  name: string;
  imageUrl: string;
  grade: string;
  gradingCompany: string;
  gradingId: string;
  set: string;
  category: string;
  vault: string;
  /** The real Collector Crypt asset this replica copies. */
  replicaOf: string;
}

const CDN = 'https://d1xpxki1g4htqu.cloudfront.net/';
export const CARD_TEMPLATES: readonly CardTemplate[] = [
  { id: 'spearow-psa9', name: '2025 Pokemon Mega Evolution IR Spearow #151', imageUrl: `${CDN}ubqFJuvrTQw8a3CzTZmLKmjveihjKefPaViuN3gEBLM`, grade: 'MINT 9', gradingCompany: 'PSA', gradingId: '152256555', set: 'Pokemon Meg EN-Mega Evolution', category: 'Pokemon', vault: 'PWCC', replicaOf: 'GonVZioARi8KAwK6ecSjWk2ZgTizgPq4XqvrcU26TfcP' },
  { id: 'sealdass-cgc8', name: '1997 Pokemon Japanese Bandai Sealdass Part 1', imageUrl: `${CDN}s-I7g23gFiJUNMMsIsdMpMikrxusdhVIzeQHBmAkOcw`, grade: 'NM/MINT 8', gradingCompany: 'CGC', gradingId: '6175439001', set: 'Pokémon - Part 1 - Japanese', category: 'Pokemon', vault: 'PWCC', replicaOf: '4JNLcGeQxRcvik76veQQLjB75TrFsYxndCMyw5hGhxRd' },
  { id: 'wooper-psa9', name: '2025 #102 Paldean Wooper PSA 9 Pfl EN-Phanta', imageUrl: `${CDN}hrP3Soe5pHxVfP3d8yH9uVPA5ZtATkd2KpIAtsgMt54`, grade: 'MINT 9', gradingCompany: 'PSA', gradingId: '167043567', set: 'Pokemon Pfl EN-Phantasmal Flames', category: 'Pokemon', vault: 'OmniVault', replicaOf: '4tQcDj2AR3m54tBkXz4dmNbZGYcEGVVK2uPUGaiGh5W1' },
  { id: 'helioptile-cgc10', name: '2025 #143 Helioptile CGC 10 Pokemon Mega Evo', imageUrl: `${CDN}YJjxmzCG0TXnUTprjjD_aS2QIWFh4z6PPSJzWJyHcEQ`, grade: 'PRISTINE 10', gradingCompany: 'CGC', gradingId: '6183258002', set: 'Mega Evolution - MEG EN - English', category: 'Pokemon', vault: 'PWCC', replicaOf: '3aWQaiiA3jzEV7Ap5E2q1TdC8cunY8jy6ABwGCDUckJa' },
  { id: 'fraxure-cgc10', name: '2025 #151 Fraxure CGC 10 Pokemon Japanese Sc', imageUrl: `${CDN}yGtnB4q3N1UApx1SYEeco4GKS6G6gpAxgJ1qWvVPN_o`, grade: 'PRISTINE 10', gradingCompany: 'CGC', gradingId: '6183132052', set: 'Black Bolt - sv11B - Japanese', category: 'Pokemon', vault: 'PWCC', replicaOf: '8VGCGYL9VH1qaHxHrVTCww6TVb2rnJS8bjPHbGUHDBxH' },
  { id: 'gengar-psa8', name: '2009 #97 Gengar LV.X-Holo PSA 8 Platinum Arc', imageUrl: `${CDN}69lC-h1HBKhTAMeuzTrdDD8Ef4ahUHyZIF6OgELetGA`, grade: 'NM-MT 8', gradingCompany: 'PSA', gradingId: '100951466', set: 'Pokemon Platinum Arceus', category: 'Pokemon', vault: 'OmniVault', replicaOf: '8T4sgEwm2e2R5XHyAz9PnViSTr9yxnXozeG1Dd336trs' },
  { id: 'volto-cgc10', name: '2026 Pokemon Mega Ascended Heroes Holo Volto', imageUrl: `${CDN}6Q5fPRLELZuGXILPElGGNyIMktHCIE_M3fcDnrOfZV4`, grade: 'PRISTINE 10', gradingCompany: 'CGC', gradingId: '6170947048', set: 'Ascended Heroes - ASC EN - English', category: 'Pokemon', vault: 'PWCC', replicaOf: '3YookXG75Daogep9N5JW788Hnyzin26hvfFjwz13YrpH' },
  { id: 'swsh-go-cgc10', name: '2022 Pokemon Japanese Sword & Shield Pokemon', imageUrl: `${CDN}qmMXPsgyrTxiuVPGUxny4_r4pD3PTY_ZsRPVPn4b9Ug`, grade: 'PRISTINE 10', gradingCompany: 'CGC', gradingId: '6177110027', set: 'Pokémon GO - s10b - Japanese', category: 'Pokemon', vault: 'PWCC', replicaOf: 'pfEjc3KtStQ8dNDboxshUYu9Emxx1KqTPqUf2TUoMUt' },
];

export const templateById = (id: string): CardTemplate | undefined => CARD_TEMPLATES.find((t) => t.id === id);

/** The on-chain name, within the Core name budget. */
export const replicaName = (t: Pick<CardTemplate, 'name'>): string => `${t.name.slice(0, 44)}${REPLICA_SUFFIX}`;

export interface Trait { trait_type: string; value: string | number }

/**
 * Metaplex-style attributes, the shape devnet_assets stores and the metadata route serves. ENGINE's `createShow` reads
 * `Grade`, `Grading Company` and `Set` from it when a lot has no catalogue row of its own.
 */
export function traitsOf(t: CardTemplate): Trait[] {
  return [
    { trait_type: 'Label', value: REPLICA_LABEL },
    { trait_type: 'Replica', value: 'true' },
    { trait_type: 'Replica of', value: t.replicaOf },
    { trait_type: 'Grade', value: t.grade },
    { trait_type: 'Grading Company', value: t.gradingCompany },
    { trait_type: 'Grading ID', value: t.gradingId },
    { trait_type: 'Set', value: t.set },
    { trait_type: 'Category', value: t.category },
    { trait_type: 'Vault', value: t.vault },
  ];
}

const LABELS: Record<string, string> = { label: 'Label', replica: 'Replica', replica_of: 'Replica of', grade: 'Grade', grading_company: 'Grading Company', grading_id: 'Grading ID', set: 'Set', category: 'Category', vault: 'Vault', insured_value_usd: 'Insured value (USD)' };

/** Reads either stored shape: the trait list, or the plain key/value object the first house-inventory run wrote. Anything else is dropped. */
export function normalizeTraits(raw: unknown): Trait[] {
  const ok = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  if (Array.isArray(raw)) {
    return raw.flatMap((a): Trait[] => (a && typeof a === 'object' && typeof (a as Trait).trait_type === 'string' && ok((a as Trait).value) ? [{ trait_type: (a as Trait).trait_type, value: (a as Trait).value }] : []));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).flatMap(([k, v]): Trait[] => (ok(v) ? [{ trait_type: LABELS[k] ?? k, value: v }] : []));
  }
  return [];
}
