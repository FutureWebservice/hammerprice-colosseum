/**
 * The Hammerprice landing page.
 *
 * Rendered both at /hp (locale-free, for a visitor with no wallet and no session) and as
 * the homepage inside the locale tree. It must work for someone who has neither - so no
 * providers, no wallet adapter, no client state. Every card is a real graded asset read
 * live from the Collector Crypt vault.
 *
 * The masthead is the "hammer falls" scroll room (story-spec.json's hero-rise room), which
 * replaces the old static kicker+h1+deck+stats block: the room itself carries the h1 (see
 * ScrollRoom). Its beat copy binds to the real open lot of the public demo show, the same
 * data source src/components/auction/AuctionRoom.tsx reads.
 *
 * Every visible string comes from src/locales/{locale}/landing.json (namespace 'landing').
 * This is a server component, so it resolves them itself via getTranslations rather than
 * relying on the client message provider.
 */
import Logo from '@/components/brand/Logo';
import { getTranslations } from 'next-intl/server';
import './hammerprice.css';
import { listCards, explorerUrl, type VaultCard } from '@/lib/vault/collector-crypt';
import { getShowWithLots } from '@/lib/catalogue';
import ScrollRoom, { type ScrollBeat } from '@/components/scrolly/ScrollRoom';
import { HERO_PINNED_VIEWPORTS, roomHeightVh } from '@/components/scrolly/room-rules';
import desktopManifestJson from '../../../public/generated/hero-rise/desktop/manifest.json';
import mobileManifestJson from '../../../public/generated/hero-rise/mobile/manifest.json';
import type { FrameManifest } from '@/components/scrolly/CanvasSequence';
import { Link, type Locale } from '@/lib/i18n';
import { DEMO_SHOW_ID } from '@/lib/demo-show';
import Journeys from './journeys/Journeys';
import WaitlistForm from './WaitlistForm';
import { legalPath } from '@/legal/routes';
import { WALLET_LINKS, formatCount, formatUsd, formatUsdcUnits, vaultFloorLabel } from './site';

type T = Awaited<ReturnType<typeof getTranslations>>;

// The public demo show (see PROJECT brief): lot 1 open, real vault card, real money fields.

/**
 * The frame manifests are IMPORTED, not read from disk.
 *
 * They used to be `fs.readFileSync(path.join(process.cwd(), 'public/generated/...'))`, which
 * works locally and fails silently on Vercel: Next's output file tracing cannot see through a
 * path built at runtime, so those two JSON files were never bundled into the serverless
 * function. readManifest caught the ENOENT, returned null, ScrollRoom saw no sequence and
 * rendered its no-JS fallback - on production only. The hero's scroll-driven frame sequence,
 * its brass tick rail and its hammer strikes were simply absent from the deployed site while
 * being present on every developer's machine, with nothing in any log to say so.
 *
 * An import is resolved at build time, so it ships. The FRAMES themselves stay in public/ and
 * are fetched by URL by CanvasSequence, which is what public/ is actually for.
 */
function asManifest(m: unknown): FrameManifest | null {
  const f = m as Partial<FrameManifest> | undefined;
  if (!f || typeof f.frameCount !== 'number' || f.frameCount < 1) return null;
  if (typeof f.frameUrlTemplate !== 'string' || typeof f.poster !== 'string') return null;
  return f as FrameManifest;
}

/** The hero room's beats, with real fields off the demo show's open lot bound into the copy -
 *  never invented numbers, per story-spec.json's copyRule. Copy text itself comes from t
 *  (namespace 'landing'), interpolated with those real fields. */
async function buildHeroRoom(t: T, locale: Locale): Promise<{ beats: ScrollBeat[]; ticks: string[] }> {
  let lot: NonNullable<Awaited<ReturnType<typeof getShowWithLots>>>['lots'][number] | null = null;
  try {
    const data = await getShowWithLots(DEMO_SHOW_ID);
    lot = data?.lots.find((l) => l.state === 'open') ?? data?.lots[0] ?? null;
  } catch {
    lot = null;
  }

  const lotNumber = lot ? String(lot.lotNumber).padStart(2, '0') : '01';
  const gradeStr = lot ? [lot.gradingCompany, lot.grade].filter(Boolean).join(' ') : '';
  const gradePart = gradeStr ? ` · ${gradeStr}` : '';
  // This is the reserve, the price a bid must clear for the lot to sell - never call it an
  // estimate, the room doesn't and neither should this page (see PROJECT brief).
  const limit = formatUsdcUnits((lot?.reserve ?? lot?.insuredValue)?.toString(), locale);
  const hammerPrice = formatUsdcUnits((lot?.highBid ?? lot?.openingPrice)?.toString(), locale);

  const ticks: string[] = [];
  if (lot) {
    let running = lot.openingPrice;
    for (let i = 0; i < 5; i++) {
      ticks.push(formatUsdcUnits(running.toString(), locale));
      running += lot.increment;
    }
  }

  // Locale-prefixed: ScrollRoom renders these as a bare <a>, not next-intl's Link, so an
  // unprefixed href sent a German visitor through a full page load and a 307 into the English
  // room. These are the hero's only two calls to action.
  const enterRoom = t('cta.enterRoom');

  const beats: ScrollBeat[] = [
    {
      // The first screen a visitor sees, no scrolling required: kicker, headline, one line
      // of what this is, and a CTA all render at full opacity at rest (beatOpacity holds 1
      // at p=0 for a beat starting at 0) - the room used to open on the kicker alone.
      id: 'cold-open',
      range: [0, 0.12],
      kicker: t('hero.coldOpen.kicker'),
      heading: t('hero.coldOpen.heading'),
      copy: t('hero.coldOpen.copy'),
      cta: { label: enterRoom, href: `/${locale}/room/house`, alt: { label: t('cta.tryAgent'), href: `/${locale}/ai` }, secondary: { label: t('cta.howItWorks'), href: `/${locale}/how-it-works` } },
    },
    {
      id: 'lot-rises',
      range: [0.12, 0.28],
      copy: t('hero.lotRises.copy', { lotNumber, gradePart, limit }),
    },
    { id: 'bids-stack', range: [0.28, 0.46], copy: t('hero.bidsStack.copy') },
    {
      // The one beat with real empty space above its copy. The auctioneer's two calls drop
      // into it as the visitor scrolls, each landing like the gavel it stands for.
      id: 'final-ten',
      range: [0.46, 0.62],
      copy: t('hero.finalTen.copy'),
      strikes: t.raw('hero.finalTen.strikes') as string[],
    },
    { id: 'hammer-falls', range: [0.62, 0.74], copy: t('hero.hammerFalls.copy') },
    { id: 'price-stamps', range: [0.74, 0.88], copy: t('hero.priceStamps.copy', { hammerPrice }) },
    {
      // End past 1.0 on purpose: scroll progress never exceeds 1, but beatOpacity's own
      // fade-out tail starts 15% of a range's *span* before its end - a [0.88, 1.0] range
      // would fade the CTA back to opacity 0 exactly as the visitor finishes scrolling.
      // Giving it room past the reachable maximum keeps it held at full opacity all the way
      // to the bottom, which is the one moment this button most needs to be visible.
      id: 'settle-cta',
      range: [0.88, 1.1],
      copy: t('hero.settleCta.copy'),
      cta: { label: enterRoom, href: `/${locale}/room/house` },
    },
  ];

  return { beats, ticks };
}

/** A dollar amount in the page's locale, always with cents. The vault API hands back raw floats
 *  (e.g. 10.449); money is never more precise than cents, and never shown with fewer. */
function Money({ value, locale }: { value: number; locale: Locale }) {
  return <span className="hp-num">{formatUsd(value, locale)}</span>;
}

/** One row of the printed catalogue: the card photo is the object, in its own well on the
 *  left; every word about it sits to the right on the page's own paper stock, never over the
 *  artwork. `featured` gives the opening lot a larger plate - the rhythm a real sale page has,
 *  not twelve identical tiles. */
function Lot({ card, n, t, featured, locale }: { card: VaultCard; n: number; t: T; featured?: boolean; locale: Locale }) {
  return (
    <article className={featured ? 'hp-lot hp-lot--feature' : 'hp-lot'}>
      <div className="hp-lot-photo">
        {card.images.front ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.images.front} alt={card.name} className="hp-lot-img" loading="lazy" />
        ) : (
          <div className="hp-lot-img hp-lot-noimg" />
        )}
      </div>
      <div className="hp-lot-body">
        <div className="hp-lot-topline">
          <span className="hp-lot-no">{t('catalogue.lot', { number: String(n).padStart(2, '0') })}</span>
          {card.gradingCompany && (
            <span className="hp-grade">
              {card.gradingCompany} {card.grade}
            </span>
          )}
        </div>
        <h3 className="hp-lot-name">{card.name}</h3>
        {card.set && <p className="hp-lot-set">{card.set}</p>}
        <div className="hp-lot-foot">
          {/* A column with no value is not drawn: the vault API leaves the insured value null for most cards,
              and an empty "Insured -" column reads as broken. */}
          {card.price != null && (
            <div>
              <div className="hp-label">{t('catalogue.ask')}</div>
              <Money value={card.price} locale={locale} />
            </div>
          )}
          {card.insuredValue != null && (
            <div>
              <div className="hp-label">{t('catalogue.insured')}</div>
              <Money value={card.insuredValue} locale={locale} />
            </div>
          )}
          {card.vault && <div className="hp-lot-vault">{card.vault}</div>}
          <Link className="hp-lot-rooms" href="/rooms">
            {t('catalogue.seeRooms')}
          </Link>
          <a className="hp-lot-link" href={explorerUrl(card.nftAddress)} target="_blank" rel="noopener noreferrer">
            {card.nftAddress.slice(0, 4)}…{card.nftAddress.slice(-4)}
          </a>
        </div>
      </div>
    </article>
  );
}

/** The names a collector, or a judge who was ten in 1999, recognises without reading. */
const SHOWCASE_ICONS = ['charizard', 'blastoise', 'venusaur', 'mewtwo', 'pikachu', 'gengar', 'lugia', 'umbreon', 'rayquaza', 'gyarados'];
const SHOWCASE_COUNT = 5;

function hasBothFaces(c: VaultCard): boolean {
  return !!(c.images.front && c.images.back && (c.price ?? c.insuredValue ?? 0) >= 1);
}

async function pickShowcaseCards(fallback: VaultCard[]): Promise<VaultCard[]> {
  let pool: VaultCard[] = [];
  try {
    pool = (await listCards({ step: 60, category: 'Pokemon' })).cards.filter(hasBothFaces);
  } catch {
    // The catalogue fetch already failed or the vault is slow; the fallback below still works.
  }
  const picked: VaultCard[] = [];
  const seen = new Set<string>();
  for (const icon of SHOWCASE_ICONS) {
    const hit = pool.find((c) => c.name.toLowerCase().includes(icon) && !seen.has(icon));
    if (hit) { picked.push(hit); seen.add(icon); }
    if (picked.length === SHOWCASE_COUNT) break;
  }
  for (const c of [...pool, ...fallback.filter(hasBothFaces)]) {
    if (picked.length === SHOWCASE_COUNT) break;
    if (!picked.some((p) => p.id === c.id)) picked.push(c);
  }
  return picked;
}

export default async function HammerpriceLanding({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'landing' });

  let cards: VaultCard[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const page = await listCards({ step: 12 });
    cards = page.cards.filter((c) => c.images.front);
    total = page.total;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // The opening beat's rotating showcase. A random dozen from the vault reads as inventory;
  // the cards a judge recognises on sight are the vintage Pokemon holos, so pull a wider
  // Pokemon page and keep the icons, one of each. Needs the ACTUAL back of the ACTUAL card,
  // so only cards the vault gave both faces for are eligible. Falls back to whatever the
  // catalogue fetch above returned with both faces, so a vault hiccup never empties the hero.
  const showcaseCards = await pickShowcaseCards(cards);

  const { beats, ticks } = await buildHeroRoom(t, locale);
  const desktopManifest = asManifest(desktopManifestJson);
  const mobileManifest = asManifest(mobileManifestJson);

  return (
    <div className="hp">
      <ScrollRoom
        durationVh={roomHeightVh(HERO_PINNED_VIEWPORTS.desktop)}
        mobileDurationVh={roomHeightVh(HERO_PINNED_VIEWPORTS.mobile)}
        beats={beats}
        ticks={ticks}
        showcaseCards={showcaseCards}
        desktopManifest={desktopManifest}
        mobileManifest={mobileManifest}
      />

      <header className="hp-head hp-head--stats">
        <div className="hp-stats">
          <div className="hp-stat">
            {/* The vault's own count when it answered, otherwise the floor the copy says elsewhere. */}
            <strong className="hp-stat-num">{total > 0 ? formatCount(total, locale) : `${vaultFloorLabel(locale)}+`}</strong>
            <span className="hp-stat-label">{t('stats.vaulted')}</span>
          </div>
          <div className="hp-stat">
            <strong className="hp-stat-num">1</strong>
            <span className="hp-stat-label">{t('stats.signature')}</span>
          </div>
          <div className="hp-stat">
            <strong className="hp-stat-num">0</strong>
            <span className="hp-stat-label">{t('stats.custody')}</span>
          </div>
        </div>
      </header>

      <section className="hp-sec hp-real" aria-labelledby="hp-real-h">
        <h2 className="hp-h2" id="hp-real-h">{t('product.heading')}</h2>
        <p>{t('product.copy')}</p>
        <p className="hp-real-links">
          <Link href="/about#how">{t('product.link')}</Link>
          <a href="#waitlist">{t('cta.joinWaitlist')}</a>
        </p>
      </section>

      <section className="hp-sec hp-waitlist" id="waitlist" aria-labelledby="hp-waitlist-h">
        <div className="hp-wl-card">
          <Logo className="hp-wl-logo" alt="Hammerprice" />
          <h2 className="hp-h2" id="hp-waitlist-h">{t('waitlist.heading')}</h2>
          <p className="hp-wl-sub">{t('waitlist.copy')}</p>
          <WaitlistForm
            locale={locale}
            privacyHref={legalPath(locale, 'datenschutz')}
            labels={{
              label: t('waitlist.label'),
              placeholder: t('waitlist.placeholder'),
              submit: t('waitlist.submit'),
              sending: t('waitlist.sending'),
              success: t('waitlist.success'),
              errorInvalid: t('waitlist.errorInvalid'),
              errorTooMany: t('waitlist.errorTooMany'),
              errorGeneric: t('waitlist.errorGeneric'),
              privacyBefore: t('waitlist.privacyBefore'),
              privacyLink: t('waitlist.privacyLink'),
            }}
          />
        </div>
      </section>

      <section className="hp-sec">
        <div className="hp-cat-head">
          <div>
            <h2 className="hp-h2">{t('catalogue.heading')}</h2>
            <p className="hp-note">{t('catalogue.note')}</p>
          </div>
          {!error && cards.length > 0 && (
            <div className="hp-cat-count">{t('catalogue.count', { count: cards.length })}</div>
          )}
        </div>
        <div className="hp-cat-rule" />
        {error ? (
          <p className="hp-error">{t('catalogue.error', { error })}</p>
        ) : (
          <div className="hp-cat-sheet">
            {cards.map((c, i) => (
              <Lot key={c.id} card={c} n={i + 1} t={t} featured={i === 0} locale={locale} />
            ))}
          </div>
        )}
      </section>

      <section className="hp-sec hp-more">
        <p>
          {t.rich('moreInfo', {
            a: (chunks) => <Link href="/about#how">{chunks}</Link>,
          })}
        </p>
      </section>

      <Journeys locale={locale} />

      <section className="hp-sec hp-wallet" id="wallet" aria-labelledby="hp-wallet-h">
        <h2 className="hp-h2" id="hp-wallet-h">{t('wallet.heading')}</h2>
        <p>{t('wallet.lede')}</p>
        <ul className="hp-wallet-links">
          {WALLET_LINKS.map((l) => (
            <li key={l.id}>
              <a href={l.href} target="_blank" rel="noopener noreferrer">{t('wallet.install')} {l.name}</a>
            </li>
          ))}
        </ul>
        <p>{t('wallet.mobile')}</p>
        <p><Link href="/faq">{t('wallet.faq')}</Link></p>
      </section>
    </div>
  );
}
