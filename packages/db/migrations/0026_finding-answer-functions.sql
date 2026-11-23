-- Answering a finding from the CLI or the dashboard (NIC-1140). The dashboard's database login
-- (docker compose) may only call these: each allows one transition on one of LGTMoose's own open
-- or outdated findings, writes its event with the person's login, and nothing else.
CREATE OR REPLACE FUNCTION "lgtmoose_claim_fix"("p_finding" uuid, "p_login" text)
RETURNS timestamp with time zone
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  "v_at" timestamp with time zone := date_trunc('milliseconds', now());
  "v_sha" text;
BEGIN
  IF "p_login" IS NULL OR length(btrim("p_login")) = 0 OR length("p_login") > 100 THEN
    RAISE EXCEPTION 'a fix claim needs a login';
  END IF;
  -- Only a finding the recheck can take: on a line of the new side.
  UPDATE "findings" SET "fix_claimed_at" = "v_at", "fix_claimed_by" = "p_login", "updated_at" = now()
   WHERE "id" = "p_finding" AND "source" = 'self' AND "status" IN ('open', 'outdated')
     AND "side" = 'RIGHT' AND "path" IS NOT NULL AND "line" IS NOT NULL
   RETURNING "raised_at_sha" INTO "v_sha";
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO "finding_events" ("finding_id", "type", "actor", "actor_login", "sha")
    VALUES ("p_finding", 'fix_claimed', 'human', "p_login", "v_sha");
  RETURN "v_at";
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lgtmoose_decline_finding"("p_finding" uuid, "p_login" text, "p_reason" text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  "v_sha" text;
  "v_held" boolean;
BEGIN
  IF "p_login" IS NULL OR length(btrim("p_login")) = 0 OR length("p_login") > 100 THEN
    RAISE EXCEPTION 'a decline needs a login';
  END IF;
  IF "p_reason" IS NULL OR length(btrim("p_reason")) = 0 OR length("p_reason") > 2000 THEN
    RAISE EXCEPTION 'a decline needs a reason of at most 2000 characters';
  END IF;
  -- The thread rule: the PR's author can't decline a blocking or protected finding.
  SELECT ("f"."severity" = 'blocking' OR "f"."rule_category" IN ('authz', 'tenant_scoping', 'money', 'secrets'))
         AND lower("p"."author") = lower("p_login")
    INTO "v_held"
    FROM "findings" "f" JOIN "pull_requests" "p" ON "p"."id" = "f"."pull_request_id"
   WHERE "f"."id" = "p_finding";
  IF "v_held" THEN
    RAISE EXCEPTION 'the pull request''s author can''t decline a blocking or protected finding';
  END IF;
  UPDATE "findings" SET "status" = 'declined', "updated_at" = now()
   WHERE "id" = "p_finding" AND "source" = 'self' AND "status" IN ('open', 'outdated')
   RETURNING "raised_at_sha" INTO "v_sha";
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO "finding_events" ("finding_id", "type", "actor", "actor_login", "sha", "reason", "learn_pending")
    VALUES ("p_finding", 'declined', 'human', "p_login", "v_sha", btrim("p_reason"), true);
  RETURN true;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "lgtmoose_claim_fix"(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "lgtmoose_decline_finding"(uuid, text, text) FROM PUBLIC;
