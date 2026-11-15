CREATE TABLE "spend_ledger" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"month" text NOT NULL,
	"day" date NOT NULL,
	"cost_usd" numeric(12, 4) NOT NULL,
	"batches" integer NOT NULL,
	"dispatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "spend_cap" text;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_run_id_review_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."review_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_ledger_month_idx" ON "spend_ledger" USING btree ("month");--> statement-breakpoint
CREATE INDEX "spend_ledger_repo_month_idx" ON "spend_ledger" USING btree ("repo","month");--> statement-breakpoint
CREATE INDEX "spend_ledger_pr_day_idx" ON "spend_ledger" USING btree ("repo","pr_number","day");--> statement-breakpoint
CREATE INDEX "spend_ledger_unsettled_idx" ON "spend_ledger" USING btree ("settled","created_at");