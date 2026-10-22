CREATE TABLE "incident_timeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "responder_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "on_call_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_timeline" ADD CONSTRAINT "incident_timeline_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_timeline" ADD CONSTRAINT "incident_timeline_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_timeline_incident_id_idx" ON "incident_timeline" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_timeline_once_idx" ON "incident_timeline" USING btree ("incident_id","kind") WHERE "incident_timeline"."kind" in ('triggered', 'notified', 'acknowledged', 'resolved');--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_responder_id_users_id_fk" FOREIGN KEY ("responder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_on_call_schedule_id_schedules_id_fk" FOREIGN KEY ("on_call_schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: incidents opened before F13 get the timeline steps we already know about
INSERT INTO "incident_timeline" ("incident_id", "kind", "actor_id", "data", "created_at")
SELECT i."id", 'triggered', NULL,
       jsonb_build_object('ruleId', i."rule_id", 'ruleName', coalesce(r."name", 'deleted rule')),
       i."triggered_at"
FROM "incidents" i LEFT JOIN "alert_rules" r ON r."id" = i."rule_id";--> statement-breakpoint
INSERT INTO "incident_timeline" ("incident_id", "kind", "actor_id", "data", "created_at")
SELECT "id", 'acknowledged', "acknowledged_by", '{"via": "dashboard"}'::jsonb, "acknowledged_at"
FROM "incidents" WHERE "acknowledged_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "incident_timeline" ("incident_id", "kind", "actor_id", "data", "created_at")
SELECT "id", 'resolved', "resolved_by", '{"resolvedIssue": false}'::jsonb, "resolved_at"
FROM "incidents" WHERE "resolved_at" IS NOT NULL;
