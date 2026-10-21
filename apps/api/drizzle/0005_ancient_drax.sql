-- Trigram matching for the title search fallback. pg_trgm is a "trusted" extension:
-- the database owner can enable it without being a superuser (works on Neon too).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "events_issue_id_environment_idx" ON "events" USING btree ("issue_id","environment");--> statement-breakpoint
CREATE INDEX "events_issue_id_release_idx" ON "events" USING btree ("issue_id","release");--> statement-breakpoint
CREATE INDEX "issues_project_id_status_last_seen_idx" ON "issues" USING btree ("project_id","status","last_seen");--> statement-breakpoint
CREATE INDEX "issues_search_idx" ON "issues" USING gin (to_tsvector('english', "title" || ' ' || coalesce("culprit", '')));--> statement-breakpoint
CREATE INDEX "issues_title_trgm_idx" ON "issues" USING gin ("title" gin_trgm_ops);