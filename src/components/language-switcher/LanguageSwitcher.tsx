'use client';

import { useState, useRef, useEffect } from 'react';
import { Locale, locales } from '@/lib/i18n';
import * as React from 'react';
import Link from 'next/link';
import { usePathname as useNextPathname } from 'next/navigation';

interface LanguageSwitcherProps {
  currentLocale: Locale;
}

export default function LanguageSwitcher({ currentLocale }: LanguageSwitcherProps) {
  // Use Next.js pathname directly
  const pathname = useNextPathname();
  
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // Add state for mounted to avoid hydration issues
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Mark as mounted after component has loaded on the client
    setMounted(true);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Get path without locale prefix to construct the new URL
  const getPathWithoutLocale = () => {
    if (!pathname) return '/';

    // Remove the locale prefix from the path
    const segments = pathname.split('/');
    if (segments.length > 1 && locales.includes(segments[1] as Locale)) {
      return '/' + segments.slice(2).join('/');
    }
    
    return pathname;
  };

  // Get URL for a specific locale
  const getLocaleUrl = (locale: Locale) => {
    const pathWithoutLocale = getPathWithoutLocale();
    return `/${locale}${pathWithoutLocale === '/' ? '' : pathWithoutLocale}`;
  };

  // Get language display names with fallbacks
  const languageNames = {
    en: 'English',
    de: 'Deutsch'
  };

  
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="px-2 py-1 flex items-center text-sm rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        {/* Don't render actual locale name until after hydration */}
        {mounted ? (
          <span>{currentLocale.toUpperCase()}</span>
        ) : (
          <span className="opacity-0">XX</span>
        )}
        <svg
          className={`ml-1 h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 py-1 bg-white dark:bg-gray-800 rounded-md shadow-lg z-10 min-w-[120px]">
          {(['en', 'de'] as const).map((locale) => (
            <Link
              key={locale}
              href={getLocaleUrl(locale)}
              className={`block w-full text-left px-4 py-2 text-sm ${
                currentLocale === locale ? 'font-bold' : ''
              } hover:bg-gray-100 dark:hover:bg-gray-700`}
              onClick={() => setIsOpen(false)}
            >
              {languageNames[locale]}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
} 