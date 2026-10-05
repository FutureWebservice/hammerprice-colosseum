'use client';

/**
 * What a hammer at this price actually costs, itemised.
 *
 * Shown in two places that ask a visitor to commit: the bid panel, before they bid, and the win
 * screen, after they have. Both need the same four lines, so both read them from here.
 *
 * The one thing this has to get right is WHO PAYS WHAT, because the obvious guess is wrong. The
 * platform's commission is charged to the SELLER, out of the proceeds (see splitFee in
 * lib/platform.ts): a bidder pays their bid and the network fee, and nothing else. A breakdown
 * that quietly added 2.5% to the buyer's line would be a lie about the product's own economics,
 * so the seller's side is spelled out rather than left to be inferred.
 *
 * SOL figures are approximations at the current rate, marked as such. USDC is what settles.
 * With no rate available they are simply absent - see formatSol.
 */
import { useLocale, useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import { formatSol, SOLANA_BASE_FEE_SOL } from './types';

/** Basis points the platform keeps, mirroring PLATFORM_FEE_BPS in lib/platform.ts. Duplicated
 *  rather than imported because that module pulls in @solana/web3.js to validate a wallet on
 *  load, which has no business in a client bundle for the sake of one integer. */
const PLATFORM_FEE_BPS = 250;

function splitDisplay(baseUnits: string): { seller: string; platform: string } | null {
  try {
    const gross = BigInt(baseUnits);
    const platform = (gross * BigInt(PLATFORM_FEE_BPS)) / BigInt(10_000);
    return { seller: (gross - platform).toString(), platform: platform.toString() };
  } catch {
    return null;
  }
}

export default function FeeBreakdown({
  amountBaseUnits,
  solUsd,
  devnet = false,
  won = false,
}: {
  /** The hammer price, in USDC base units. */
  amountBaseUnits: string | null | undefined;
  solUsd: number | null;
  /** On devnet the settlement authority pays the network fee, so the buyer pays no SOL. */
  devnet?: boolean;
  /** The bid has already won: the heading says what you pay, not what would happen. */
  won?: boolean;
}) {
  const t = useTranslations('room');
  const locale = useLocale();
  const usd = useUsd();
  if (amountBaseUnits == null || amountBaseUnits === '') return null;
  const split = splitDisplay(amountBaseUnits);
  if (!split) return null;

  const hammerSol = formatSol(amountBaseUnits, solUsd);
  // Explicit locale: toLocaleString(undefined) printed a German decimal comma on the English page.
  const pct = (PLATFORM_FEE_BPS / 100).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', { maximumFractionDigits: 2 });

  return (
    <div className="hp-fees">
      <p className="hp-fees-head">{t(won ? 'fees.headingWon' : 'fees.heading')}</p>
      <dl className="hp-fees-rows">
        <div>
          <dt>{t('fees.hammer')}</dt>
          <dd>
            {usd(amountBaseUnits)}
            {hammerSol && <span className="hp-fees-sol">≈ {hammerSol}</span>}
          </dd>
        </div>
        <div>
          <dt>{t('fees.network')}</dt>
          <dd>
            {devnet ? t('fees.networkDevnet') : <span className="hp-fees-sol">≈ {SOLANA_BASE_FEE_SOL.toFixed(6)} SOL</span>}
          </dd>
        </div>
        <div className="is-total">
          <dt>{t('fees.youPay')}</dt>
          <dd>{t(devnet ? 'fees.youPayDevnet' : 'fees.youPayValue', { amount: usd(amountBaseUnits) })}</dd>
        </div>
        <div>
          <dt>{t('fees.sellerGets')}</dt>
          <dd>{usd(split.seller)}</dd>
        </div>
      </dl>
      <p className="hp-fees-note">
        {t('fees.commission', { pct, amount: usd(split.platform) })}
      </p>
      {hammerSol && <p className="hp-fees-note">{t('fees.approx')}</p>}
    </div>
  );
}
