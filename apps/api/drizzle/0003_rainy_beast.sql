CREATE TYPE "public"."issue_status" AS ENUM('unresolved', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TABLE "issue_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_users" (
	"issue_id" uuid NOT NULL,
	"user_key" text NOT NULL,
	CONSTRAINT "issue_users_issue_id_user_key_pk" PRIMARY KEY("issue_id","user_key")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"type" text,
	"culprit" text,
	"status" "issue_status" DEFAULT 'unresolved' NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"is_regression" boolean DEFAULT false NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"user_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_project_id_fingerprint_unique" UNIQUE("project_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_users" ADD CONSTRAINT "issue_users_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_activity_issue_id_idx" ON "issue_activity" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issues_project_id_last_seen_idx" ON "issues" USING btree ("project_id","last_seen");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_issue_id_timestamp_idx" ON "events" USING btree ("issue_id","timestamp");