-- 0006 pack third-party delivery (A14): the buyer pays the pack OPERATOR directly (nothing goes to a platform wallet), the draw runs after the payment is final,
-- and the OPERATOR signs the delivery of the drawn card before a deadline. A draw the operator does not deliver (or voids by moving the card) is marked
-- `undelivered`, costs the operator a strike and pauses the pack.
-- Purely additive and idempotent (IF NOT EXISTS everywhere), like 0003 to 0005: nothing is dropped, renamed or retyped; the previous code keeps working
-- while and after this runs (it does not know the new columns and never writes status 'undelivered').
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "deliver_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "undelivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "undelivered_reason" text;--> statement-breakpoint
ALTER TABLE "pack_draws" ADD COLUMN IF NOT EXISTS "strike_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_card_held_idx" ON "pack_draws" USING btree ("card_id") WHERE status in ('drawn','delivering','settled','refund_pending','refunding','undelivered');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_draws_deliver_by_idx" ON "pack_draws" USING btree ("status","deliver_by");
