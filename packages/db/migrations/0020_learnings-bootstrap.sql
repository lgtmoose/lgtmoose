CREATE TYPE "public"."learning_bootstrap_status" AS ENUM('requested', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "learning_bootstrap_items" (
	"learning_id" uuid PRIMARY KEY NOT NULL,
	"bootstrap_id" uuid NOT NULL,
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_bootstraps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" "learning_bootstrap_status" DEFAULT 'requested' NOT NULL,
	"max_prs" integer NOT NULL,
	"max_cost_usd" numeric(10, 4) NOT NULL,
	"before_pr" integer,
	"oldest_pr_read" integer,
	"prs_read" integer DEFAULT 0 NOT NULL,
	"comments_read" integer DEFAULT 0 NOT NULL,
	"proposed" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"capped" boolean DEFAULT false NOT NULL,
	"execution_arn" text,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spend_ledger" DROP CONSTRAINT "spend_ledger_run_id_review_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "learning_bootstrap_items" ADD CONSTRAINT "learning_bootstrap_items_learning_id_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."learnings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_bootstrap_items" ADD CONSTRAINT "learning_bootstrap_items_bootstrap_id_learning_bootstraps_id_fk" FOREIGN KEY ("bootstrap_id") REFERENCES "public"."learning_bootstraps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_bootstrap_items_bootstrap_idx" ON "learning_bootstrap_items" USING btree ("bootstrap_id");--> statement-breakpoint
CREATE INDEX "learning_bootstraps_repo_idx" ON "learning_bootstraps" USING btree ("repo","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_bootstraps_active_key" ON "learning_bootstraps" USING btree ("repo") WHERE "learning_bootstraps"."status" in ('requested', 'running');