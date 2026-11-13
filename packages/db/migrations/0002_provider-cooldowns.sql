CREATE TABLE "provider_cooldowns" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
