CREATE TABLE "artifacts" (
	"key" text PRIMARY KEY NOT NULL,
	"body" "bytea" NOT NULL,
	"etag" text NOT NULL,
	"content_type" text DEFAULT 'text/plain' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"group_id" text NOT NULL,
	"dedupe_id" text NOT NULL,
	"body" text NOT NULL,
	"locked_until" timestamp with time zone,
	"receive_count" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_executions" (
	"arn" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"cause" text,
	"owner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_queue_dedupe_key" ON "job_queue" USING btree ("queue","dedupe_id");--> statement-breakpoint
CREATE INDEX "job_queue_waiting_idx" ON "job_queue" USING btree ("queue","group_id","id") WHERE "job_queue"."done_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "local_executions_name_key" ON "local_executions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "local_executions_running_idx" ON "local_executions" USING btree ("created_at") WHERE "local_executions"."status" = 'RUNNING';