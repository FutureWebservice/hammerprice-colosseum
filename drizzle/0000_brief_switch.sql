CREATE TYPE "public"."lot_state" AS ENUM('catalogued', 'open', 'sold', 'passed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."show_format" AS ENUM('auction', 'buy_now');--> statement-breakpoint
CREATE TYPE "public"."show_status" AS ENUM('scheduled', 'live', 'ended');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_wallet" text,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"signature" text NOT NULL,
	"message" text NOT NULL,
	"nonce" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" uuid,
	"seller_id" uuid NOT NULL,
	"lot_number" integer NOT NULL,
	"mint_address" text NOT NULL,
	"nft_standard" text NOT NULL,
	"vault_ref" text,
	"name" text NOT NULL,
	"set_name" text,
	"grading_company" text,
	"grade" text,
	"grading_id" text,
	"image_url" text,
	"insured_value" bigint,
	"reserve" bigint,
	"increment" bigint NOT NULL,
	"high_bid" bigint,
	"high_bidder_id" uuid,
	"state" "lot_state" DEFAULT 'catalogued' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"username" text,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"is_seller" boolean DEFAULT false NOT NULL,
	"is_banned" boolean DEFAULT false NOT NULL,
	"banned_reason" text,
	"banned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "profiles_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"gross_amount" bigint NOT NULL,
	"platform_fee" bigint NOT NULL,
	"seller_amount" bigint NOT NULL,
	"tx_signature" text NOT NULL,
	"usd_value_at_time" numeric(14, 2),
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "show_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "show_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"show_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "show_presence" (
	"show_id" uuid NOT NULL,
	"viewer_key" text NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "show_secrets" (
	"show_id" uuid PRIMARY KEY NOT NULL,
	"ingest_path" text NOT NULL,
	"publish_token" text NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"format" "show_format" DEFAULT 'auction' NOT NULL,
	"status" "show_status" DEFAULT 'scheduled' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_bidder_id_profiles_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_profiles_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_seller_id_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_high_bidder_id_profiles_id_fk" FOREIGN KEY ("high_bidder_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_buyer_id_profiles_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_seller_id_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_events" ADD CONSTRAINT "show_events_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_presence" ADD CONSTRAINT "show_presence_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_secrets" ADD CONSTRAINT "show_secrets_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_seller_id_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_nonces_expiry_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bids_lot_idx" ON "bids" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_bidder_nonce_idx" ON "bids" USING btree ("bidder_id","nonce");--> statement-breakpoint
CREATE INDEX "chat_show_idx" ON "chat_messages" USING btree ("show_id","created_at");--> statement-breakpoint
CREATE INDEX "lots_show_idx" ON "lots" USING btree ("show_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_show_number_idx" ON "lots" USING btree ("show_id","lot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_tx_idx" ON "settlements" USING btree ("tx_signature");--> statement-breakpoint
CREATE INDEX "settlements_lot_idx" ON "settlements" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "show_events_cursor_idx" ON "show_events" USING btree ("show_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "presence_pk" ON "show_presence" USING btree ("show_id","viewer_key");--> statement-breakpoint
CREATE INDEX "presence_seen_idx" ON "show_presence" USING btree ("show_id","last_seen");--> statement-breakpoint
CREATE INDEX "shows_seller_idx" ON "shows" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "shows_status_idx" ON "shows" USING btree ("status");