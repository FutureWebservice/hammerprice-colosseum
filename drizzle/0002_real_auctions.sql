CREATE TABLE "app_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devnet_assets" (
	"mint" text PRIMARY KEY NOT NULL,
	"owner_wallet" text NOT NULL,
	"name" text NOT NULL,
	"image_url" text,
	"attributes" jsonb NOT NULL,
	"minted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paddles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"session_pubkey" text,
	"max_bid" bigint,
	"valid_until" timestamp with time zone NOT NULL,
	"auth_message" text NOT NULL,
	"auth_signature" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "tx_signature" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "settled_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "settled_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "via" text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "paddle_id" uuid;--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "funded_amount" bigint;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN "closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN "bid_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN "buy_now_price" bigint;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN "consign_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "strikes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "is_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "status" text DEFAULT 'awaiting_payment' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "rail" text DEFAULT 'cosign' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "cluster" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "mint_address" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "prepared_message" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "prepared_blockhash" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "last_valid_height" bigint;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "round_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "buyer_signature" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "seller_signature" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "failure_detail" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "bid_log_hash" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "memo" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "royalty_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "royalty_recipient" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "rail_state" jsonb;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "settlement_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "cluster" text;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "is_house" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paddles" ADD CONSTRAINT "paddles_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paddles" ADD CONSTRAINT "paddles_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devnet_assets_owner_idx" ON "devnet_assets" USING btree ("owner_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "paddles_show_profile_idx" ON "paddles" USING btree ("show_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paddles_show_number_idx" ON "paddles" USING btree ("show_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_pk" ON "rate_limits" USING btree ("key","window_start");--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_paddle_id_paddles_id_fk" FOREIGN KEY ("paddle_id") REFERENCES "public"."paddles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bids_bidder_idx" ON "bids" USING btree ("bidder_id","placed_at");--> statement-breakpoint
CREATE INDEX "lots_open_closes_idx" ON "lots" USING btree ("closes_at") WHERE state = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "lots_one_open_per_show" ON "lots" USING btree ("show_id") WHERE state = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_one_active_per_lot" ON "settlements" USING btree ("lot_id") WHERE status in ('awaiting_payment','awaiting_seller','submitted','settled');--> statement-breakpoint
CREATE INDEX "settlements_status_due_idx" ON "settlements" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "shows_sched_idx" ON "shows" USING btree ("status","scheduled_at");