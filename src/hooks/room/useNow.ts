'use client';

import { useEffect, useState } from 'react';

/**
 * Client time, ticking every `ms`. `null` until mounted, so the server render and the first client render
 * agree (this is what removes the hydration mismatch #418: nothing time-based is drawn before mount).
 */
export function useNow(ms = 250): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
