-- 0006 rostrum: the seller's pause. A paused show refuses bids and freezes the open lot's clock; resuming shifts the lot's
-- closes_at by the paused time. shows.paused_at is the pause in effect (null = running), shows.pause_count the pauses used (at most 2, enforced by the service),
-- lots.paused_ms the total time the lot's clock was frozen (the anti-sniping extension cap counts from opened_at + paused_ms).
-- Purely additive and idempotent (every statement is IF NOT EXISTS), like 0003 to 0005: nothing is dropped, renamed or retyped, every new column is
-- nullable or has a default, and a running deployment of the previous code keeps working while and after this runs (it never reads or writes them).
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "paused_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN IF NOT EXISTS "pause_count" integer DEFAULT 0 NOT NULL;
