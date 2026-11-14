CREATE TABLE "dispatched_executions" (
	"execution_arn" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_request_dispatches" (
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_dispatches_repo_number_pk" PRIMARY KEY("repo","number")
);
--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "review_submitted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "dispatched_executions_active_idx" ON "dispatched_executions" USING btree ("repo","number") WHERE "dispatched_executions"."stopped_at" is null;