'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import LanguageSwitcher from '../language-switcher/LanguageSwitcher';
import { Link } from '@/lib/i18n';
import { usePathname as useNextPathname } from 'next/navigation';
import { defaultLocale, getUserLocale, getLocaleFromPath } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import { WalletErrorBoundary } from '../wallet/WalletErrorBoundary';
import ConnectWalletButton from '../room/ConnectWalletButton';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSession } from '@/components/auth/SessionProvider';
import SignInNotice from '@/components/auth/SignInNotice';
import { shortAddress } from '@/components/sell/chain-links';
import HelpMenu from '@/components/tour/HelpMenu';
import { packsNavOn } from '@/lib/client/features';
import Logo from '@/components/brand/Logo';

// Helper function for safer translations
function useTranslationsWithFallback(namespace: string) {
  try {
    return useTranslations(namespace);
  } catch (error) {
    console.error(`Error loading translations for ${namespace}:`, error);
    // Return a function that returns the key as fallback
    return ((key: string) => key) as unknown as ReturnType<typeof useTranslations>;
  }
}

const WalletButtonWithErrorHandling = () => (
  <WalletErrorBoundary>
    <ConnectWalletButton />
  </WalletErrorBoundary>
);

// Hammerprice palette (see src/components/landing/hammerprice.css). Colors are hardcoded
// here: the header renders on routes (e.g. /about) that don't otherwise load that
// stylesheet. The faces are self-hosted by next/font in [locale]/layout.tsx and exposed as
// CSS variables on <html>.
const MONO_STACK = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace';
const BRASS = '#C8A44D';
const BRASS_HOVER = '#E8C776';
const PAPER = '#F4F0E6';
const SLATE = '#9AA3B2';

/**
 * Who is signed in, and the one action that applies: sign in (wallet connected, no session yet) or sign out.
 * The wallet button next to it connects the wallet; this shows the server session, which is a separate step.
 */
function SessionControl({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations('account');
  const s = useSession();
  const { signMessage, signIn } = useWallet();
  if (s.status === 'signed-in' && s.me) {
    return (
      <span className="flex items-center gap-2" data-testid="session-control">
        <Link href="/account" prefetch={false} onClick={onNavigate} className="text-[11px] uppercase tracking-[0.08em]" style={{ fontFamily: MONO_STACK, color: PAPER }} data-testid="session-account">
          {t('session.signedIn')} <span style={{ textTransform: 'none' }}>{shortAddress(s.me.wallet)}</span>
        </Link>
        <button type="button" onClick={() => void s.signOut()} className="text-[11px] uppercase tracking-[0.08em] underline-offset-4 hover:underline" style={{ fontFamily: MONO_STACK, color: '#A3ACB5' }} data-testid="session-signout">
          {t('session.signOut')}
        </button>
      </span>
    );
  }
  if (s.connected && (signMessage || signIn)) {
    return (
      <span className="flex flex-col items-start gap-1">
        <button type="button" disabled={s.status === 'signing-in'} onClick={() => void s.signIn()} className="text-[11px] uppercase tracking-[0.08em] underline-offset-4 hover:underline" style={{ fontFamily: MONO_STACK, color: BRASS_HOVER }} data-testid="session-signin">
          {s.status === 'signing-in' ? t('session.signingIn') : t('session.signIn')}
        </button>
        <SignInNotice compact />
      </span>
    );
  }
  return null;
}

// Only the schedule is fetched ahead of a click (it is where a visitor goes next, and a room is one more click from it). Next fetches every link that is on
// screen as soon as the page has loaded, the whole next page each (30 to 50 kB), which on the landing page was five pages and in a room six: the rest load on the click.
const PREFETCHED: ReadonlySet<string> = new Set(['/rooms']);

// Locale-free paths in nav order, the same on every page and in the room. Labels come from the nav namespace.
// Profile is the account page (it asks for a wallet itself). Packs has an entry point only where the feature is on
// (FEATURE_PACKS, see lib/client/features.ts): the pages answer 404 while it is off. How it works, the pitch and the
// FAQ are sections of the About page (footer and Help), not items in the bar.
const NAV = [
  { path: '/', key: 'home', fallback: 'Home' },
  { path: '/rooms', key: 'rooms', fallback: 'Rooms' },
  { path: '/sell', key: 'sell', fallback: 'Sell' },
  { path: '/account', key: 'profile', fallback: 'Profile' },
  { path: '/ai', key: 'ai', fallback: 'AI agent' },
] as const;
const PACKS_NAV = { path: '/packs', key: 'packs', fallback: 'Packs' } as const;
const ABOUT_NAV = { path: '/about', key: 'about', fallback: 'About' } as const;

// What the Help button lists on a wide screen, as plain links for the phone menu (the tour itself is replayed from the room's Help button).
const HELP_LINKS = [
  { key: 'glossary', href: '/about#glossary' },
  { key: 'wallet', href: '/about#wallet' },
  { key: 'faq', href: '/about#faq' },
] as const;

/**
 * The one site header. `compact` is the same header inside an auction room: same wordmark, links in the same
 * order, same tokens, same Help, language switcher, wallet and account entry, but 56 px instead of 80, sticky,
 * Help kept in the bar on a phone (the room's tour points at it) and 60 px kept free on the right for the
 * floating "How it works" bubble that docks there inside a room (see auction.css). The room's own status line
 * (title, live or timed badge) is a slim row under it, rendered by RoomShell.
 */
export default function Header({ compact = false }: { compact?: boolean }) {
  const pathname = useNextPathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const t = useTranslationsWithFallback('nav');

  const currentLocale: Locale = getLocaleFromPath(pathname) || getUserLocale() || defaultLocale;

  const navItems = [...NAV, ...(packsNavOn() ? [PACKS_NAV] : []), ABOUT_NAV];

  const label = (key: string, fallback: string) => (t(key) || fallback).toUpperCase();
  const ta = useTranslations('account');
  const th = useTranslations('tour');

  // Is `path` (locale-less, e.g. "/rooms") the active route for the current pathname?
  const localeRoot = `/${currentLocale}`;
  const isActive = (path: string) => {
    if (path === '/') return pathname === localeRoot || pathname === `${localeRoot}/`;
    // A room is a place inside Rooms.
    if (path === '/rooms' && pathname.startsWith(`${localeRoot}/room/`)) return true;
    const full = `${localeRoot}${path}`;
    return pathname === full || pathname.startsWith(`${full}/`);
  };

  const navLinkClass = (active: boolean) =>
    `text-[11px] uppercase tracking-[0.08em] py-1.5 border-b transition-colors duration-200 ${
      active ? 'border-[#C8A44D]' : 'border-transparent hover:text-[#F4F0E6]'
    }`;
  const navLinkStyle = (active: boolean) => ({
    fontFamily: MONO_STACK,
    color: active ? PAPER : SLATE,
  });

  // Close mobile menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('[data-mobile-menu-button]')) {
        return;
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  // A navigation closes the drawer (the locale layout keeps the header mounted between pages).
  useEffect(() => setMobileMenuOpen(false), [pathname]);

  // Prevent body scrolling when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  return (
    <header
      className={`bg-[#0E1116] border-b border-[#C8A44D]/25 pointer-events-auto ${compact ? 'sticky top-0 z-[46]' : 'relative z-50'}`}
      data-testid="site-header"
      data-compact={compact ? 'true' : undefined}
    >
      <style jsx global>{`
        .site-wallet .wallet-adapter-button {
          background: transparent !important;
          border: 1px solid ${BRASS} !important;
          color: ${BRASS_HOVER} !important;
          font-family: ${MONO_STACK} !important;
          font-size: 11px !important;
          letter-spacing: 0.06em !important;
          text-transform: uppercase !important;
          height: 34px !important;
          border-radius: 3px !important;
          padding: 0 14px !important;
          box-shadow: none !important;
        }
        .site-wallet .wallet-adapter-button:hover {
          background: rgba(200, 164, 77, 0.12) !important;
        }
        .site-wallet .wallet-adapter-button-trigger {
          background: transparent !important;
        }
        /* The room is a full-height column: it subtracts the compact bar (56 px plus its 1 px border) from its 100dvh (auction.css). */
        body:has([data-testid='site-header'][data-compact='true']) {
          --hp-bar-h: 57px;
        }
      `}</style>

      <div className={`container mx-auto flex items-center justify-between ${compact ? 'h-14 pl-4 pr-[60px]' : 'h-20 px-4'}`}>
        <Link href="/" aria-label="Hammerprice" className="flex items-center z-10 transition-opacity duration-300 hover:opacity-85">
          {compact ? (
            <>
              <Logo variant="symbol" className="h-8 w-auto sm:hidden" />
              <Logo className="hidden sm:block h-7 w-auto" />
            </>
          ) : (
            <Logo className="h-7 sm:h-8 w-auto" />
          )}
        </Link>

        <nav className="hidden md:flex items-center space-x-6 lg:space-x-8 relative z-10" aria-label={t('main')}>
          {navItems.map((n) => (
            <Link key={n.path} href={n.path} prefetch={PREFETCHED.has(n.path) ? undefined : false} className={navLinkClass(isActive(n.path))} style={navLinkStyle(isActive(n.path))} aria-current={isActive(n.path) ? 'page' : undefined} data-testid={`nav-${n.key}`}>
              {label(n.key, n.fallback)}
            </Link>
          ))}
        </nav>

        <div className="flex items-center space-x-2 sm:space-x-4 z-10">
          {/* From 640 px up the Help button sits in the bar. On a phone the bar has no room for it, so the same pages are listed in the menu; the room's bar keeps it (its tour ends there). */}
          <div className={compact ? 'block' : 'hidden sm:block'}><HelpMenu /></div>
          <div className="hidden sm:block">
            <LanguageSwitcher currentLocale={currentLocale} />
          </div>

          <div className="hidden sm:flex items-center gap-3">
            <div className="site-wallet">
              <WalletButtonWithErrorHandling />
            </div>
            <SessionControl />
          </div>

          <button
            data-mobile-menu-button
            className="md:hidden p-3 text-[#F4F0E6] hover:text-[#E8C776] transition-colors duration-200 bg-white/5 rounded-lg border border-[#C8A44D]/25"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={ta('session.menu')}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            data-testid="mobile-menu-button"
          >
            {mobileMenuOpen ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile Menu (slide-in drawer) */}
      <div
        ref={mobileMenuRef}
        id="mobile-menu"
        inert={!mobileMenuOpen}
        className="fixed inset-0 z-[100] transform md:hidden -translate-x-full transition-transform duration-300 ease-in-out"
        style={{ transform: mobileMenuOpen ? 'translateX(0)' : 'translateX(-100%)' }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={() => setMobileMenuOpen(false)}></div>

        <div className="absolute inset-y-0 left-0 max-w-[320px] w-[85vw] flex flex-col border-r border-[#C8A44D]/25 bg-[#0E1116] shadow-2xl">
          <div className="flex items-center justify-between p-4 border-b border-[#C8A44D]/20">
            <Link href="/" aria-label="Hammerprice" className="flex items-center" onClick={() => setMobileMenuOpen(false)}>
              <Logo className="h-7 w-auto" />
            </Link>
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="p-2 text-[#F4F0E6] hover:text-[#E8C776] transition-colors duration-200"
              aria-label={ta('session.closeMenu')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto py-4" aria-label={t('main')}>
            {navItems.map((n) => (
              <Link
                key={n.path}
                href={n.path}
                onClick={() => setMobileMenuOpen(false)}
                className="block px-6 py-3 text-[11px] uppercase tracking-[0.08em]"
                style={navLinkStyle(isActive(n.path))}
                aria-current={isActive(n.path) ? 'page' : undefined}
                data-testid={`mobile-nav-${n.key}`}
              >
                {label(n.key, n.fallback)}
              </Link>
            ))}
          </nav>

          <nav className="border-t border-[#C8A44D]/20 py-2" aria-label={th('help.label')}>
            {HELP_LINKS.map((h) => (
              <Link
                key={h.key}
                href={h.href}
                onClick={() => setMobileMenuOpen(false)}
                className="block px-6 py-3 text-[11px] uppercase tracking-[0.08em]"
                style={navLinkStyle(false)}
                data-testid={`mobile-help-${h.key}`}
              >
                {th(`help.${h.key}`).toUpperCase()}
              </Link>
            ))}
          </nav>

          <div className="border-t border-[#C8A44D]/20 p-4 pb-24 space-y-4">
            <div className="flex items-center justify-between">
              <span style={{ fontFamily: MONO_STACK, color: SLATE }} className="text-[11px] uppercase tracking-[0.08em]">
                {ta('session.language')}
              </span>
              <LanguageSwitcher currentLocale={currentLocale} />
            </div>

            <div className="w-full site-wallet">
              <WalletButtonWithErrorHandling />
            </div>
            <SessionControl onNavigate={() => setMobileMenuOpen(false)} />
          </div>
        </div>
      </div>
    </header>
  );
}
