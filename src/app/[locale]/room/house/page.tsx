/**
 * /room/house: one stable link to the house room. Starts the next house show when none is running and lets a due one go live, then resolves on the
 * server (src/server/house/resolve.ts) to a room that is LIVE right now: the live house show, else a live timed demo lot (`?kind=timed` asks for the
 * timed one first), and redirects there. A show that has not started is never a redirect target (it would open with nothing to bid on yet): the page says
 * when it starts and links to it. Only when nothing is live or scheduled does it open the last show that ended, or, with no house show at all, explain.
 */
import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/lib/i18n';
import { resolveHouseRoom } from '@/server/house/resolve';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'rooms' });
  return { title: t('houseNone.title'), robots: { index: false } };
}

const utc = (iso: string) => `${iso.slice(11, 16)}`;

export default async function HouseRoomPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams?: Promise<{ kind?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { kind } = (await searchParams) ?? {};
  const target = await resolveHouseRoom({ prefer: kind === 'timed' ? 'timed' : 'live' });
  if (target && target.status !== 'scheduled') redirect(`/${locale}/room/${target.id}`);
  const t = await getTranslations({ locale, namespace: 'rooms' });
  const next = target?.status === 'scheduled' && target.startsAt ? target : null;
  return (
    <div className="hp">
      <header className="hp-head rm-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="hp-h1">{next ? t('houseNext.title') : t('houseNone.title')}</h1>
        <p className="rm-explainer" data-testid={next ? 'house-next' : 'house-none'}>{next ? t('houseNext.body', { time: utc(next.startsAt!) }) : t('houseNone.body')}</p>
        <p className="rm-explainer">
          {next && <><Link href={`/room/${next.id}`} className="hp-inline-link">{t('houseNext.open')}</Link>{' · '}</>}
          <Link href="/rooms" className="hp-inline-link">{t('houseNone.rooms')}</Link>
          {' · '}
          <Link href="/about#how" className="hp-inline-link">{t('houseNone.how')}</Link>
        </p>
      </header>
    </div>
  );
}
