CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_project_id_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_project_id_version_unique" UNIQUE("project_id","version")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "first_release" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_release" text;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "releases_project_id_last_seen_idx" ON "releases" USING btree ("project_id","last_seen");--> statement-breakpoint
CREATE INDEX "issues_project_id_first_release_idx" ON "issues" USING btree ("project_id","first_release");--> statement-breakpoint
-- Backfill: events stored before F9 get their releases, environments and issue releases too
INSERT INTO "releases" ("project_id", "version", "first_seen", "last_seen", "event_count")
SELECT "project_id", "release", min("timestamp"), max("timestamp"), count(*)::int
FROM "events" WHERE "release" IS NOT NULL
GROUP BY "project_id", "release";--> statement-breakpoint
INSERT INTO "environments" ("project_id", "name", "first_seen", "last_seen", "event_count")
SELECT "project_id", "environment", min("timestamp"), max("timestamp"), count(*)::int
FROM "events"
GROUP BY "project_id", "environment";--> statement-breakpoint
UPDATE "issues" SET "first_release" = first_event."release"
FROM (
  SELECT DISTINCT ON ("issue_id") "issue_id", "release" FROM "events"
  WHERE "issue_id" IS NOT NULL AND "release" IS NOT NULL
  ORDER BY "issue_id", "timestamp" ASC, "id" ASC
) AS first_event
WHERE first_event."issue_id" = "issues"."id";--> statement-breakpoint
UPDATE "issues" SET "last_release" = last_event."release"
FROM (
  SELECT DISTINCT ON ("issue_id") "issue_id", "release" FROM "events"
  WHERE "issue_id" IS NOT NULL AND "release" IS NOT NULL
  ORDER BY "issue_id", "timestamp" DESC, "id" DESC
) AS last_event
WHERE last_event."issue_id" = "issues"."id";
