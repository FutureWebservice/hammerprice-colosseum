'use client';

/**
 * The one "Advanced options" fold. A thin wrapper around <details>: the title is always the same word, the look is
 * the same everywhere, and whether it is open is remembered per `id` for the browser session (sessionStorage, which
 * may be missing: then it simply starts closed). Use it for everything a first-time visitor does not need.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { browserStore, readFlag, writeFlag } from '@/lib/client/safe-storage';
import './ux.css';

export const advancedKey = (id: string) => `hp.adv.${id}`;

export default function Advanced({ id, children, className = '', bodyClassName = '', defaultOpen = false }: { id: string; children: ReactNode; className?: string; bodyClassName?: string; defaultOpen?: boolean }) {
  const t = useTranslations('tour');
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    const v = readFlag(browserStore('session'), advancedKey(id));
    if (v === '1') setOpen(true);
    else if (v === '0') setOpen(false);
  }, [id]);

  return (
    <details className={`ux-adv ${className}`.trim()} open={open} data-testid={`advanced-${id}`} onToggle={(e) => {
      const o = e.currentTarget.open;
      setOpen(o);
      writeFlag(browserStore('session'), advancedKey(id), o ? '1' : '0');
    }}>
      <summary>{t('advanced.title')}</summary>
      <div className={`ux-adv-body ${bodyClassName}`.trim()}>{children}</div>
    </details>
  );
}
