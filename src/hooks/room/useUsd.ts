'use client';

import { useCallback } from 'react';
import { useLocale } from 'next-intl';
import { formatUsdc } from '@/components/auction/types';

/** formatUsdc bound to the page locale ("$1,234.56" in en, "1.234,56 $" in de). */
export function useUsd() {
  const locale = useLocale();
  return useCallback((units: string | null | undefined) => formatUsdc(units, locale), [locale]);
}
