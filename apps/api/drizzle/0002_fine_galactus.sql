CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid,
	"event_id" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"type" text,
	"message" text,
	"stacktrace" jsonb,
	"environment" text NOT NULL,
	"release" text,
	"user" jsonb,
	"request" jsonb,
	"tags" jsonb,
	"context" jsonb,
	"sdk" jsonb,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_project_id_event_id_unique" UNIQUE("project_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_project_id_timestamp_idx" ON "events" USING btree ("project_id","timestamp");