CREATE TABLE "dashboard_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"orgs" jsonb NOT NULL,
	"repos" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dashboard_sessions_expires_idx" ON "dashboard_sessions" USING btree ("expires_at");