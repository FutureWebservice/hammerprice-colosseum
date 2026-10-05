import type { Locale } from '@/lib/i18n';
import { listCards } from '@/lib/vault/collector-crypt';
import { formatCount, vaultFloorLabel } from '@/components/landing/site';

/** The vault's own count, or a floor if the vault is slow: true either way, and a floor does not age the wrong direction. */
export async function vaultTotal(locale: Locale): Promise<string> {
  try {
    const page = await listCards({ step: 1 });
    if (page.total > 0) return formatCount(page.total, locale);
  } catch {
    // Unreachable right now; the floor below is still true.
  }
  return `${vaultFloorLabel(locale)}+`;
}
