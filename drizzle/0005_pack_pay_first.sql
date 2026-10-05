-- 0005 pack pay first: a chance pack is paid BEFORE the draw. The buyer pays, the payment is finalized on chain, only then is the card
-- chosen (ECVRF, the payment signature is part of the input), delivered by the house in a second transaction, or the buyer is refunded.
-- Purely additive and idempotent (every statement is IF NOT EXISTS or relaxes a constraint), like 0003 and 0004: nothing is dropped, renamed or retyped,
-- existing rows keep flow 'atomic' and behave as before, and a running deployment of the previous code keeps working while and after this runs
-- (it never writes draw_index as null and does not know the new columns).
ALTER TABLE "pack_draws" ALTER COLUMN "draw_index" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "flow" text DEFAULT 'atomic' NOT NULL;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "payment_slot" bigint;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "drawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "delivery_signature" text;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "refund_signature" text;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "server_tx" text;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "server_last_valid" bigint;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "refund_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "refund_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_card_live_idx" ON "pack_draws" USING btree ("card_id") WHERE status in ('drawn','delivering','settled','refund_pending','refunding');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_delivery_tx_idx" ON "pack_draws" USING btree ("delivery_signature");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_refund_tx_idx" ON "pack_draws" USING btree ("refund_signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_draws_status_idx" ON "pack_draws" USING btree ("status","next_attempt_at");
