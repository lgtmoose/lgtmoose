import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { ConfigError, toConfigError } from "./errors.js";

export const DEFAULT_CONVENTIONS = [
  "CLAUDE.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/*.mdc",
] as const;

const glob = z.string().min(1, "globs can't be empty");

/**
 * When a PR is reviewed (`review.trigger`, NIC-1077): on every push (`auto`), only while it
 * carries the trigger label (`label`), or only on `@lgtmoose review` (`command`).
 */
export const REVIEW_TRIGGERS = ["auto", "label", "command"] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

/** The label that starts a review with `review.trigger: label`, unless the config names another. */
export const DEFAULT_TRIGGER_LABEL = "lgtmoose:review";

export const repoConfigSchema = z
  .object({
    rulepacks: z
      .array(z.string().min(1))
      .default(["generic"])
      .describe(
        "Rule packs to review with: built-in or private pack ids, and ./rules/<name>.md or ./rules/*.md from this repository. generic and security are always on.",
      ),
    conventions: z
      .array(glob)
      .default([...DEFAULT_CONVENTIONS])
      .describe("Files of team conventions the reviewer reads, as globs."),
    /** Risk tiers, most important first. Keys are tier numbers 1–7; tests always go last. */
    tiers: z
      .record(z.string().regex(/^[1-7]$/, "tier keys are numbers 1 to 7"), z.array(glob))
      .default({})
      .describe(
        "Risk tiers, most important first: keys 1 to 7, each a list of globs. Files are reviewed in tier order; tests go last.",
      ),
    /**
     * Globs for files never to review, on top of the planner's defaults (lockfiles, build
     * output, vendored, generated and minified files, binaries). They win over `include`.
     */
    skip: z
      .array(glob)
      .default([])
      .describe(
        "Globs never to review, on top of the defaults (lockfiles, build output, vendored, generated and binary files). They win over include.",
      ),
    /**
     * Globs for files to review even though a default skip matches them, such as real source in
     * `build/` or a hand-written `*.generated.ts`. `skip` globs still win, and binaries are
     * always skipped. An included lockfile is reviewed as text, without lockfile notes.
     */
    include: z
      .array(glob)
      .default([])
      .describe(
        "Globs to review even though a default skip matches them. skip still wins, and binaries are always skipped.",
      ),
    /**
     * Extra package hosts to trust in lockfiles, such as a private registry, on top of the
     * public ones. Packages resolved from them aren't flagged in the review summary.
     */
    registries: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
            "registries are lowercase host names",
          ),
      )
      .default([])
      .describe("Extra package hosts to trust in lockfiles, such as a private registry."),
    gate: z
      .object({
        check_run: z
          .enum(["required", "optional", "off"])
          .default("required")
          .describe(
            "The LGTMoose check run. required: it fails on open blocking findings. optional: failing and held results are posted as neutral. off: no check run.",
          ),
        approve: z
          .boolean()
          .default(true)
          .describe("false: a clean review posts COMMENT instead of APPROVE."),
        nit_cap: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(10)
          .describe("Most nits posted in one review. The rest are counted in the summary."),
      })
      .strict()
      .prefault({})
      .describe("How a review's decision is posted."),
    /**
     * The prompt-injection detector. `allow`: globs for files whose added lines aren't scanned,
     * such as tests and docs about prompt injection. Their contents still reach the reviewer, so
     * keep the globs narrow. The PR's title, body and comments are always scanned.
     */
    injection: z
      .object({
        allow: z
          .array(glob)
          .default([])
          .describe(
            "Globs whose added lines the prompt-injection detector doesn't scan, such as its own tests. Keep them narrow.",
          ),
      })
      .strict()
      .prefault({})
      .describe("The prompt-injection detector."),
    review: z
      .object({
        trigger: z
          .enum(REVIEW_TRIGGERS)
          .default("auto")
          .describe(
            "When a PR is reviewed. auto: when it's opened, marked ready or pushed to. label: only while it carries review.label. command: only on @lgtmoose review.",
          ),
        on_push: z
          .enum(["auto", "manual"])
          .default("auto")
          .describe(
            "After a PR's first review. auto: each push is reviewed again. manual: only the label (being added again) or @lgtmoose review reviews it again.",
          ),
        label: z
          .string()
          .min(1)
          .max(50)
          .default(DEFAULT_TRIGGER_LABEL)
          .describe("The label that starts a review with trigger: label."),
        label_once: z
          .boolean()
          .default(false)
          .describe(
            "With trigger: label, remove the label when its review starts, so the author adds it again for the next round.",
          ),
        trusted_bots: z
          .array(
            z
              .string()
              .regex(
                /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/,
                "trusted_bots are bot logins, like claude[bot]",
              ),
          )
          .max(20)
          .default([])
          .describe(
            "Bot logins, such as claude[bot], whose review.label or @lgtmoose review starts a review. They can do nothing else.",
          ),
      })
      .strict()
      .prefault({})
      .describe(
        "When reviews run: on every push, or only when a label, a command or a trusted agent says the PR is ready.",
      ),
    labels: z
      .object({
        pending: z
          .string()
          .min(1)
          .default("Ready for Review")
          .describe(
            "Set when a review holds for a person: it was incomplete, or flagged a prompt-injection attempt.",
          ),
        changes: z
          .string()
          .min(1)
          .default("Requires Changes")
          .describe("Set when blocking or should-fix findings are open."),
        approved: z
          .string()
          .min(1)
          .default("Approved")
          .describe(
            "Set when no blocking or should-fix finding is open, also with gate.approve: false.",
          ),
      })
      .strict()
      .prefault({})
      .describe("The three status labels LGTMoose keeps on a PR: pending, changes and approved."),
  })
  .strict();

export type RepoConfigInput = z.input<typeof repoConfigSchema>;
export type RepoConfig = z.output<typeof repoConfigSchema>;

/** Validates an already-parsed repo config object and fills defaults. */
export function parseRepoConfig(input: unknown, source = ".lgtmoose.yaml"): RepoConfig {
  const result = repoConfigSchema.safeParse(input ?? {});
  if (!result.success) throw toConfigError(source, result.error);
  return result.data;
}

/** Parses the text of a .lgtmoose.yaml file. A missing or empty file gives the defaults. */
export function parseRepoConfigYaml(
  text: string | undefined,
  source = ".lgtmoose.yaml",
): RepoConfig {
  let data: unknown;
  try {
    data = text === undefined ? undefined : parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const line = error.linePos?.[0]?.line;
      throw new ConfigError(source, [
        { path: "", message: `not valid YAML${line ? ` (line ${line})` : ""}: ${error.message}` },
      ]);
    }
    throw error;
  }
  return parseRepoConfig(data, source);
}

/** The three status labels (pending, changes, approved), so callers never hard-code them. */
export function statusLabels(config: RepoConfig): readonly [string, string, string] {
  return [config.labels.pending, config.labels.changes, config.labels.approved];
}
