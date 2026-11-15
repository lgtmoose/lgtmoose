ALTER TYPE "public"."learning_event_type" ADD VALUE 'reinforced';--> statement-breakpoint
ALTER TYPE "public"."learning_event_type" ADD VALUE 'not_followed';--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "learning_ids" text[];--> statement-breakpoint
ALTER TABLE "learning_events" ADD COLUMN "finding_id" uuid;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "pattern_key" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;