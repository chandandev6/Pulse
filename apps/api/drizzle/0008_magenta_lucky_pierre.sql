CREATE TYPE "public"."notification_channel_type" AS ENUM('email', 'sms', 'push', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"org_id" uuid,
	"type" "notification_channel_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_severity" "issue_severity" DEFAULT 'low' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_one_owner" CHECK (("notification_channels"."user_id" is null) <> ("notification_channels"."org_id" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid,
	"channel_id" uuid,
	"org_id" uuid,
	"channel_type" "notification_channel_type" NOT NULL,
	"recipient" text NOT NULL,
	"trigger" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_channels_user_id_idx" ON "notification_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_channels_org_id_idx" ON "notification_channels" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_once_idx" ON "notification_log" USING btree ("incident_id","channel_id","trigger");--> statement-breakpoint
CREATE INDEX "notification_log_org_id_created_at_idx" ON "notification_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_log_channel_id_idx" ON "notification_log" USING btree ("channel_id","created_at");--> statement-breakpoint
-- Backfill: every existing user gets their account email as a contact method,
-- the same thing signup does from now on
INSERT INTO "notification_channels" ("user_id", "type", "name", "config")
SELECT "id", 'email', 'Account email', jsonb_build_object('address', "email") FROM "users";
