CREATE TYPE "public"."learning_event_type" AS ENUM('proposed', 'applied', 'approved', 'retired');--> statement-breakpoint
CREATE TABLE "learning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learning_id" uuid NOT NULL,
	"type" "learning_event_type" NOT NULL,
	"actor" text NOT NULL,
	"actor_permission" text NOT NULL,
	"github_comment_id" bigint,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "learning_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_learning_id_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."learnings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_events_learning_idx" ON "learning_events" USING btree ("learning_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "learnings_source_comment_key" ON "learnings" USING btree ("source_repo","source_comment_id");