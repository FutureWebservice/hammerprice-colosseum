-- 0003 features: schema for the optional features (VRF order, timed shows, video flag, pre-moderated chat, AI credits, packs).
-- Purely additive and idempotent (every statement is IF NOT EXISTS or guarded), so it can be applied twice and on a database
-- that already has some of it. Nothing is dropped, renamed or retyped; every new column is nullable or has a default, so a
-- running deployment of the previous code keeps working while and after this runs.
CREATE TABLE IF NOT EXISTS "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"cluster" text,
	"status" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"thinking_tokens" integer,
	"cost_micro_usd" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_mutes" (
	"show_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text DEFAULT 'mute' NOT NULL,
	"until" timestamp with time zone,
	"reason" text NOT NULL,
	"by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"reporter_id" uuid,
	"reason" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"cluster" text NOT NULL,
	"credits" integer NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL,
	"prepared_message" text,
	"prepared_blockhash" text,
	"last_valid_height" bigint,
	"round_expires_at" timestamp with time zone,
	"tx_signature" text,
	"memo" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_profile_id" uuid NOT NULL,
	"operator_wallet" text NOT NULL,
	"is_house" boolean DEFAULT false NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"image_url" text,
	"mode" text NOT NULL,
	"cluster" text NOT NULL,
	"price" bigint NOT NULL,
	"odds" jsonb NOT NULL,
	"odds_hash" text,
	"pool_hash" text,
	"committed_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"per_wallet_daily_cap" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"buyer_profile_id" uuid NOT NULL,
	"buyer_wallet" text NOT NULL,
	"cluster" text NOT NULL,
	"draw_index" integer NOT NULL,
	"age_confirmed_at" timestamp with time zone NOT NULL,
	"client_seed" text NOT NULL,
	"vrf_request_id" uuid,
	"vrf_input" text,
	"proof_hex" text,
	"output_hex" text,
	"tier" text,
	"card_id" uuid,
	"asset" text,
	"price" bigint NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"settlement_ref" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"prepared_message" text,
	"prepared_blockhash" text,
	"last_valid_height" bigint,
	"round_expires_at" timestamp with time zone,
	"buyer_signature" text,
	"operator_signature" text,
	"tx_signature" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_pool_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"tier" text NOT NULL,
	"name" text NOT NULL,
	"image_url" text,
	"listed_value" bigint,
	"attributes" jsonb,
	"position" integer NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_purchase_counts" (
	"wallet" text NOT NULL,
	"pack_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vrf_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"cluster" text NOT NULL,
	"public_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reveal_by" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"commit_tx_b64" text,
	"commit_signature" text,
	"commit_slot" bigint,
	"beacon_slot" bigint,
	"beacon_blockhash" text,
	"alpha_text" text,
	"proof_hex" text,
	"output_hex" text,
	"reveal_tx_b64" text,
	"reveal_signature" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revealed_at" timestamp with time zone,
	"defaulted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "chat_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "paddle_number" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "lot_number" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'bidder' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "moderated_by" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "client_nonce" text;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "description" jsonb;--> statement-breakpoint
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "ai_assisted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN IF NOT EXISTS "order_mode" text DEFAULT 'catalogue' NOT NULL;--> statement-breakpoint
ALTER TABLE "shows" ADD COLUMN IF NOT EXISTS "video_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_mutes" ADD CONSTRAINT "chat_mutes_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_mutes" ADD CONSTRAINT "chat_mutes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_mutes" ADD CONSTRAINT "chat_mutes_by_profiles_id_fk" FOREIGN KEY ("by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reporter_id_profiles_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_handled_by_profiles_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_definitions" ADD CONSTRAINT "pack_definitions_operator_profile_id_profiles_id_fk" FOREIGN KEY ("operator_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_draws" ADD CONSTRAINT "pack_draws_pack_id_pack_definitions_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."pack_definitions"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_draws" ADD CONSTRAINT "pack_draws_buyer_profile_id_profiles_id_fk" FOREIGN KEY ("buyer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_draws" ADD CONSTRAINT "pack_draws_vrf_request_id_vrf_requests_id_fk" FOREIGN KEY ("vrf_request_id") REFERENCES "public"."vrf_requests"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_draws" ADD CONSTRAINT "pack_draws_card_id_pack_pool_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."pack_pool_cards"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_pool_cards" ADD CONSTRAINT "pack_pool_cards_pack_id_pack_definitions_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."pack_definitions"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pack_purchase_counts" ADD CONSTRAINT "pack_purchase_counts_pack_id_pack_definitions_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."pack_definitions"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_usage_req_idx" ON "ai_usage" USING btree ("kind","request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_day_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_mutes_pk" ON "chat_mutes" USING btree ("show_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_reports_once_idx" ON "chat_reports" USING btree ("message_id","reporter_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_ref_idx" ON "credit_ledger" USING btree ("reason","ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_profile_idx" ON "credit_ledger" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_purchases_tx_idx" ON "credit_purchases" USING btree ("tx_signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_definitions_status_idx" ON "pack_definitions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_definitions_operator_idx" ON "pack_definitions" USING btree ("operator_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_index_idx" ON "pack_draws" USING btree ("pack_id","draw_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_card_idx" ON "pack_draws" USING btree ("card_id") WHERE status in ('reserved','submitted','settled');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_draws_tx_idx" ON "pack_draws" USING btree ("tx_signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_draws_buyer_idx" ON "pack_draws" USING btree ("buyer_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_pool_cards_asset_idx" ON "pack_pool_cards" USING btree ("pack_id","asset");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_pool_cards_tier_idx" ON "pack_pool_cards" USING btree ("pack_id","status","tier");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_purchase_counts_pk" ON "pack_purchase_counts" USING btree ("wallet","pack_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vrf_requests_subject_idx" ON "vrf_requests" USING btree ("purpose","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vrf_requests_open_idx" ON "vrf_requests" USING btree ("status","reveal_by");--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_moderated_by_profiles_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_seq_idx" ON "chat_messages" USING btree ("show_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_status_idx" ON "chat_messages" USING btree ("show_id","status","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_created_idx" ON "chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_nonce_idx" ON "chat_messages" USING btree ("author_id","client_nonce") WHERE client_nonce is not null;