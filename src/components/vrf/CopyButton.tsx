'use client';

import { useState } from 'react';
import type { VrfT } from './text';

/** Copies `value` to the clipboard; says so for two seconds. A browser without clipboard access leaves the text selectable and shows nothing. */
export default function CopyButton({ value, t }: { value: string; t: VrfT }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* no clipboard: the key stays selectable */ }
  };
  return <button type="button" className="vrf-btn is-small" data-testid="vrf-copy" onClick={() => void copy()} aria-live="polite">{done ? t('fields.copied') : t('fields.copy')}</button>;
}
