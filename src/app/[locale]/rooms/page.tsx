/**
 * /rooms: the schedule. The heading and explainer render on the server; the list itself is a client
 * component over GET /api/shows (live, scheduled with a countdown from scheduledAt, ended), so it is always the
 * server's current answer and nothing on the page is fixed copy about a particular room.
 */
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/lib/i18n';
import Schedule from '@/components/sell/Schedule';
import { pageMetadata } from '@/components/landing/seo';
import './rooms.css';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'rooms' });
  const title = t('meta.title');
  const description = t('meta.description');
  return pageMetadata({ locale: locale === 'de' ? 'de' : 'en', path: '/rooms', title, description });
}

export default async function RoomsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'rooms' });
  return (
    <div className="hp">
      <header className="hp-head rm-head">
        <div className="hp-rule" />
        <p className="hp-kicker">{t('kicker')}</p>
        <h1 className="hp-h1">{t('title')}</h1>
        <p className="rm-explainer">{t('explainer')}</p>
        <p className="rm-head-cta">
          <Link href="/room/house" className="hpx-btn" data-testid="rooms-head-demo">{t('demo.open')}</Link>
          <Link href="/sell" className="hpx-btn hpx-btn--ghost" data-testid="rooms-head-sell">{t('sellers.cta')}</Link>
        </p>
      </header>
      <Schedule />
    </div>
  );
}
