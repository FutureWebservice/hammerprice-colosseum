import type { Metadata, Viewport } from 'next';
import { Inter, Instrument_Serif, Geist, Geist_Mono, DM_Sans } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { locales, defaultLocale } from '@/lib/i18n';
import { loadMessages } from '@/lib/i18n/messages';
import { CHROME, pickMessages } from '@/lib/i18n/route-namespaces';
import { TIME_ZONE } from '@/lib/i18n/PageMessages';
import { SolanaWalletProvider } from '@/components/wallet/WalletProvider';
import { SessionProvider } from '@/components/auth/SessionProvider';
import SiteChrome from '@/components/layout/SiteChrome';
import { getExplainMessages } from '@/components/explain/content';
import { ToastProvider } from '@/components/ui/toast';
import type { Locale } from '@/lib/i18n';
import '@/app/globals.css';

// Every face is self-hosted by next/font (downloaded at build time, served from our own origin),
// so no visitor's IP reaches Google. Each exposes a CSS variable that the stylesheets use:
// --font-inter (body), --font-serif (headlines), --font-sans and --font-mono (the room and landing).
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
const instrumentSerif = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], display: 'swap', variable: '--font-serif' });
const geist = Geist({ subsets: ['latin'], display: 'swap', variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-mono' });
// The wallet modal's face. Not preloaded: it is only needed once the modal opens.
const dmSans = DM_Sans({ subsets: ['latin'], weight: ['400', '500', '700'], display: 'swap', variable: '--font-dm-sans', preload: false });

// No production domain exists yet; the dev alias is the closest thing to a
// real live URL, and NEXT_PUBLIC_SITE_URL overrides it once one does.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://hammerprice-earn.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // No title.template: every page below sets its own full, self-contained title (some
  // already did, e.g. rooms.json's "Hammerprice: the schedule") - a template would double
  // the brand name on those instead of adding it to the ones without it.
  title: 'Hammerprice',
  // One explicit icon set (files in public/). The ?v= suffix makes a browser that cached an older
  // favicon fetch the current one; bump it when the mark changes.
  icons: {
    icon: [
      { url: '/favicon.ico?v=2', sizes: '48x48' },
      { url: '/icons/icon.svg?v=2', type: 'image/svg+xml', sizes: 'any' },
      { url: '/icons/icon-192.png?v=2', type: 'image/png', sizes: '192x192' },
    ],
    apple: { url: '/apple-touch-icon.png?v=2', sizes: '180x180', type: 'image/png' },
  },
  manifest: '/manifest.webmanifest',
  description: 'Live auctions for graded cards already vaulted on-chain, settled in USDC on Solana in one signature.',
  openGraph: {
    siteName: 'Hammerprice',
    type: 'website',
    images: [{ url: '/opengraph-image', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/opengraph-image'],
  },
};

// No maximumScale: pinch-zoom stays available (WCAG 1.4.4). The page is built to reflow.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0E1116',
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

interface Props {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function LocaleLayout({ children, params }: Props) {
  // Next.js 15 requires params to be properly awaited
  const resolvedParams = await params;
  
  const locale = (resolvedParams?.locale && typeof resolvedParams.locale === 'string' && 
                  locales.includes(resolvedParams.locale as Locale)) 
    ? resolvedParams.locale 
    : defaultLocale;
  
  // Validate if locale is supported
  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  // Without this, next-intl reads the locale from headers() and every page renders
  // dynamically (private, no-store). With it the pages are static and CDN-cacheable.
  setRequestLocale(locale);

  // The client provider here carries only what the page chrome reads (CHROME); each route group adds its own namespaces below
  // (src/lib/i18n/route-namespaces.ts, PageMessages.tsx), so no page ships the texts of the others.
  const messages = await loadMessages(locale);
  const chromeMessages = pickMessages(messages, CHROME);

  // Ensure consistent timezone - to avoid hydration mismatches for date formatting
  const timeZone = TIME_ZONE;

  return (
    <html lang={locale} className={`${inter.className} ${inter.variable} ${instrumentSerif.variable} ${geist.variable} ${geistMono.variable} ${dmSans.variable} dark`}>
      <body>
        <NextIntlClientProvider locale={locale} messages={chromeMessages} timeZone={timeZone}>
          <SolanaWalletProvider>
            <SessionProvider>
              <ToastProvider>
                <div className="bg-[#0E1116] text-white flex min-h-screen flex-col">
                  {/* The ribbon's label is resolved here rather than inside the client
                      component: SiteChrome sits above the room's own tree and the ribbon is the
                      one string it needs, so a server-resolved prop beats another provider. */}
                  <SiteChrome pitchLabel={(messages.nav?.pitchRibbon as string | undefined) ?? 'Read the pitch'} skipLabel={(messages.common?.skipToContent as string | undefined) ?? 'Skip to content'} explainLabel={getExplainMessages(locale as Locale).bubble.label}>
                    <main id="main-content" tabIndex={-1} className="flex-grow focus:outline-none">{children}</main>
                  </SiteChrome>
                </div>
              </ToastProvider>
            </SessionProvider>
          </SolanaWalletProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
} 