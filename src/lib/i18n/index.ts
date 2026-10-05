import { createNavigation } from 'next-intl/navigation';
import { defineRouting } from 'next-intl/routing';
import { locales, defaultLocale } from './config';
import type { Locale } from './config';

export { locales, defaultLocale };
export type { Locale };

// Define routing configuration
export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: 'always',
  // No NEXT_LOCALE cookie: the URL prefix already says it, and a Set-Cookie on every response
  // makes the page uncacheable at the CDN.
  localeCookie: false,
});

// Create Link and redirect utilities for working with localized routes
// Use 'always' to match middleware configuration
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);

// Simple locale display mapping
const localeDisplayNames: Record<Locale, Record<Locale, string>> = {
  en: {
    en: 'English',
    de: 'German'
  },
  de: {
    en: 'Englisch',
    de: 'Deutsch'
  }
};

// Function to get the display name of a locale without using Intl.DisplayNames
export function getLocaleDisplayName(locale: Locale, inLocale: Locale = 'en'): string {
  return localeDisplayNames[inLocale]?.[locale] || locale;
}

// Function to set locale in cookies
export function saveUserLocale(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

// Function to get locale from cookies
export function getUserLocale(): Locale | null {
  // Server-side rendering check
  if (typeof document === 'undefined') return null;
  
  try {
    const matches = document.cookie.match(new RegExp('(^| )NEXT_LOCALE=([^;]+)'));
    const locale = matches ? matches[2] : null;
    return (locale === 'en' || locale === 'de') ? locale as Locale : null;
  } catch (e) {
    console.error('Error reading locale from cookie:', e);
    return null;
  }
}

// Function to extract locale from URL path
export function getLocaleFromPath(path: string): Locale | null {
  if (!path) return null;
  
  const pathParts = path.split('/').filter(Boolean);
  if (pathParts.length > 0) {
    const firstPart = pathParts[0];
    if (locales.includes(firstPart as Locale)) {
      return firstPart as Locale;
    }
  }
  
  return null;
}