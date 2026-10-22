CREATE TYPE "public"."rotation_type" AS ENUM('daily', 'weekly', 'custom');--> statement-breakpoint
CREATE TABLE "schedule_layer_participants" (
	"layer_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "schedule_layer_participants_layer_id_position_pk" PRIMARY KEY("layer_id","position")
);
--> statement-breakpoint
CREATE TABLE "schedule_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"rotation_type" "rotation_type" NOT NULL,
	"shift_length_hours" integer,
	"handoff_time" text NOT NULL,
	"start_date" date NOT NULL,
	"restriction" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_overrides_ends_after_start" CHECK ("schedule_overrides"."ends_at" > "schedule_overrides"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_layer_participants" ADD CONSTRAINT "schedule_layer_participants_layer_id_schedule_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."schedule_layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_layer_participants" ADD CONSTRAINT "schedule_layer_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_layers" ADD CONSTRAINT "schedule_layers_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_overrides" ADD CONSTRAINT "schedule_overrides_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_overrides" ADD CONSTRAINT "schedule_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_overrides" ADD CONSTRAINT "schedule_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_layer_participants_user_id_idx" ON "schedule_layer_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_layers_schedule_id_position_idx" ON "schedule_layers" USING btree ("schedule_id","position");--> statement-breakpoint
CREATE INDEX "schedule_overrides_schedule_id_ends_at_idx" ON "schedule_overrides" USING btree ("schedule_id","ends_at");--> statement-breakpoint
CREATE INDEX "schedules_org_id_idx" ON "schedules" USING btree ("org_id");