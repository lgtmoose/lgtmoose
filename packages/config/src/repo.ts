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

export const repoConfigSchema = z
  .object({
    rulepacks: z.array(z.string().min(1)).default(["generic"]),
    conventions: z.array(glob).default([...DEFAULT_CONVENTIONS]),
    /** Risk tiers, most important first. Keys are tier numbers 1–7; tests always go last. */
    tiers: z
      .record(z.string().regex(/^[1-7]$/, "tier keys are numbers 1 to 7"), z.array(glob))
      .default({}),
    skip: z.array(glob).default([]),
    gate: z
      .object({
        check_run: z.enum(["required", "optional", "off"]).default("required"),
        approve: z.boolean().default(true),
        nit_cap: z.number().int().min(0).max(100).default(10),
      })
      .strict()
      .prefault({}),
    labels: z
      .object({
        pending: z.string().min(1).default("Ready for Review"),
        changes: z.string().min(1).default("Requires Changes"),
        approved: z.string().min(1).default("Approved"),
      })
      .strict()
      .prefault({}),
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
