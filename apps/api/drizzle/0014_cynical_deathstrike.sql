ALTER TABLE "notification_channels" ADD COLUMN "verified_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
-- Channels made before verification existed count as verified (ADD COLUMN ... DEFAULT now() already did this)
COMMENT ON COLUMN "notification_channels"."verified_at" IS 'null = waiting for the owner to enter the code sent to this address';
