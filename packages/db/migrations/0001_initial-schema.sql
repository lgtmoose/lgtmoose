CREATE TYPE "public"."diff_side" AS ENUM('LEFT', 'RIGHT');--> statement-breakpoint
CREATE TYPE "public"."finding_event_type" AS ENUM('raised', 'replied', 'fixed', 'declined', 'dispute_answered', 'resolved', 'outdated');--> statement-breakpoint
CREATE TYPE "public"."finding_source" AS ENUM('self', 'bot', 'human');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'fixed', 'declined', 'disputed', 'resolved_by_human', 'outdated');--> statement-breakpoint
CREATE TYPE "public"."learning_kind" AS ENUM('accepted_pattern', 'correction', 'convention', 'scoping');--> statement-breakpoint
CREATE TYPE "public"."learning_status" AS ENUM('pending', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."reaction" AS ENUM('+1', '-1');--> statement-breakpoint
CREATE TYPE "public"."review_depth" AS ENUM('full', 'move', 'mechanical', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('first', 'incremental', 'comments', 'full');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('blocking', 'should_fix', 'nit');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"reaction" "reaction" NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files_reviewed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"depth" "review_depth" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"type" "finding_event_type" NOT NULL,
	"actor" text NOT NULL,
	"sha" text,
	"github_comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"run_id" uuid,
	"fingerprint" text NOT NULL,
	"rule_category" text NOT NULL,
	"severity" "severity" NOT NULL,
	"path" text,
	"line" integer,
	"start_line" integer,
	"side" "diff_side",
	"title" text NOT NULL,
	"body" text NOT NULL,
	"raised_at_sha" text NOT NULL,
	"source" "finding_source" DEFAULT 'self' NOT NULL,
	"source_login" text,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"github_comment_id" bigint,
	"github_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"repo" text,
	"path_glob" text,
	"kind" "learning_kind" NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024),
	"status" "learning_status" DEFAULT 'pending' NOT NULL,
	"source_repo" text,
	"source_pr" integer,
	"source_comment_id" bigint,
	"author" text NOT NULL,
	"author_permission" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"role" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 4),
	"limit_hit" boolean DEFAULT false NOT NULL,
	"fell_back_to" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" integer NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"author" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"last_reviewed_sha" text,
	"comments_through" timestamp with time zone,
	"status_label" text,
	"summary_comment_id" bigint,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"head_sha" text NOT NULL,
	"from_sha" text,
	"kind" "run_kind" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"execution_arn" text,
	"files_total" integer,
	"files_done" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4),
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_reviewed" ADD CONSTRAINT "files_reviewed_run_id_review_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."review_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_review_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_run_id_review_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."review_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_finding_actor_reaction_key" ON "feedback" USING btree ("finding_id","actor","reaction");--> statement-breakpoint
CREATE UNIQUE INDEX "files_reviewed_run_path_key" ON "files_reviewed" USING btree ("run_id","path");--> statement-breakpoint
CREATE INDEX "finding_events_finding_idx" ON "finding_events" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_pull_request_fingerprint_key" ON "findings" USING btree ("pull_request_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_open_idx" ON "findings" USING btree ("pull_request_id") WHERE "findings"."status" = 'open';--> statement-breakpoint
CREATE INDEX "learnings_scope_idx" ON "learnings" USING btree ("org","repo","status");--> statement-breakpoint
CREATE INDEX "learnings_embedding_idx" ON "learnings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "provider_usage_provider_idx" ON "provider_usage" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_repo_number_key" ON "pull_requests" USING btree ("repo","number");--> statement-breakpoint
CREATE INDEX "review_runs_pull_request_idx" ON "review_runs" USING btree ("pull_request_id","created_at");