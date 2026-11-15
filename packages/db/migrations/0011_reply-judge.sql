CREATE TYPE "public"."pending_reply_status" AS ENUM('pending', 'judged', 'skipped');--> statement-breakpoint
CREATE TABLE "pending_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"github_comment_id" bigint NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"status" "pending_reply_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_replies" ADD CONSTRAINT "pending_replies_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_replies" ADD CONSTRAINT "pending_replies_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_replies_comment_key" ON "pending_replies" USING btree ("github_comment_id");--> statement-breakpoint
CREATE INDEX "pending_replies_pull_request_idx" ON "pending_replies" USING btree ("pull_request_id","status","created_at");