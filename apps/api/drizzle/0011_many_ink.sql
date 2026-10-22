CREATE TABLE "escalation_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"timeout_minutes" integer NOT NULL,
	CONSTRAINT "escalation_levels_policy_position_unique" UNIQUE("policy_id","position")
);
--> statement-breakpoint
CREATE TABLE "escalation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"repeat_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level_id" uuid NOT NULL,
	"user_id" uuid,
	"schedule_id" uuid,
	CONSTRAINT "escalation_targets_one_target" CHECK (("escalation_targets"."user_id" is null) <> ("escalation_targets"."schedule_id" is null))
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "escalation_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "escalation_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "next_escalation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "escalation_levels" ADD CONSTRAINT "escalation_levels_policy_id_escalation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_targets" ADD CONSTRAINT "escalation_targets_level_id_escalation_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."escalation_levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_targets" ADD CONSTRAINT "escalation_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_targets" ADD CONSTRAINT "escalation_targets_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escalation_policies_org_id_idx" ON "escalation_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "escalation_targets_level_id_idx" ON "escalation_targets" USING btree ("level_id");--> statement-breakpoint
CREATE INDEX "escalation_targets_user_id_idx" ON "escalation_targets" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_escalation_policy_id_escalation_policies_id_fk" FOREIGN KEY ("escalation_policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_escalation_policy_id_escalation_policies_id_fk" FOREIGN KEY ("escalation_policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE set null ON UPDATE no action;