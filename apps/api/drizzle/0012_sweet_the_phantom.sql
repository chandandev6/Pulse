CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rate_limit_per_minute" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "monthly_quota" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "scrub_data" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "scrub_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "scrub_ip_addresses" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log" USING btree ("org_id","created_at","id");