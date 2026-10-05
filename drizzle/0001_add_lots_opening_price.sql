-- Opening price: half the estimate (reserve, falling back to insured value, falling back to
-- $1), rounded to the nearest whole USDC, minimum $1. Same formula as
-- catalogue.ts:defaultOpeningPrice, so the backfill matches what importVaultCard would have
-- written had the column existed from the start.
ALTER TABLE "lots" ADD COLUMN "opening_price" bigint;
--> statement-breakpoint
UPDATE "lots" SET "opening_price" = GREATEST(
  1000000,
  ((COALESCE("reserve", "insured_value", 1000000) / 2 + 500000) / 1000000) * 1000000
);
--> statement-breakpoint
ALTER TABLE "lots" ALTER COLUMN "opening_price" SET NOT NULL;
