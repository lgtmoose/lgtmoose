import { ROLES, type Role } from "@lgtmoose/config";
import type { Harness } from "@lgtmoose/harness";
import { inline } from "@lgtmoose/summary";
import { z } from "zod";
import type { Fixture } from "./fixture.js";
import { buildReport, type EvalReport } from "./report.js";
import { runFixtures } from "./run.js";
import type { FixtureScore } from "./score.js";
import type { EvalProvider } from "./providers.js";

/**
 * The roles the review pipeline runs today. The others (`crossFile`, `verifier`, …) have
 * prompts but no step that runs them yet, so an assignment naming one would measure nothing.
 */
export const EVALUATED_ROLES: readonly Role[] = ["reviewer"];

/** One configuration to evaluate: a provider for each role. */
export interface Assignment {
  /** `reviewer=claude`, or with more roles `reviewer=claude,verifier=chatgpt`. */
  label: string;
  roles: Partial<Record<Role, string>>;
}

function labelOf(roles: Partial<Record<Role, string>>): string {
  return ROLES.flatMap((role) => {
    const provider = roles[role];
    return provider === undefined ? [] : [`${role}=${provider}`];
  }).join(",");
}

function checkProvider(id: string, providers: Readonly<Record<string, EvalProvider>>): void {
  if (providers[id] === undefined) {
    throw new Error(
      `Unknown provider ${JSON.stringify(id)}. Use one of: ${Object.keys(providers).join(", ")}.`,
    );
  }
}

/** `--providers claude,chatgpt`: the reviewer on each provider in turn. */
export function assignmentsFromProviders(
  list: string,
  providers: Readonly<Record<string, EvalProvider>>,
): Assignment[] {
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0) throw new Error("--providers needs at least one provider.");
  for (const id of ids) checkProvider(id, providers);
  return [...new Set(ids)].map((id) => ({ label: `reviewer=${id}`, roles: { reviewer: id } }));
}

/**
 * `--roles reviewer=claude,verifier=chatgpt`: one configuration with a provider per role. The
 * reviewer is required; a role the pipeline doesn't run yet is refused, so a table never shows
 * numbers for a role that didn't run.
 */
export function assignmentFromRoles(
  spec: string,
  providers: Readonly<Record<string, EvalProvider>>,
): Assignment {
  const roles: Partial<Record<Role, string>> = {};
  for (const part of spec.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const [role, provider, ...rest] = entry.split("=").map((piece) => piece.trim());
    if (role === undefined || provider === undefined || provider === "" || rest.length > 0) {
      throw new Error(`--roles takes role=provider pairs, such as reviewer=claude: got ${entry}.`);
    }
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new Error(`Unknown role ${JSON.stringify(role)}. Roles: ${ROLES.join(", ")}.`);
    }
    const known = role as Role;
    if (!EVALUATED_ROLES.includes(known)) {
      throw new Error(
        `The review pipeline doesn't run the ${known} role yet (only ${EVALUATED_ROLES.join(", ")}), so it can't be evaluated.`,
      );
    }
    if (roles[known] !== undefined) throw new Error(`--roles names ${known} twice in ${spec}.`);
    checkProvider(provider, providers);
    roles[known] = provider;
  }
  if (roles.reviewer === undefined) {
    throw new Error(`--roles needs a reviewer, such as reviewer=claude: got ${spec}.`);
  }
  return { label: labelOf(roles), roles };
}

/** Every configuration from the flags, in order, each once. */
export function matrixAssignments(
  flags: { providers?: string | undefined; roles?: readonly string[] | undefined },
  providers: Readonly<Record<string, EvalProvider>>,
): Assignment[] {
  const all = [
    ...(flags.providers === undefined ? [] : assignmentsFromProviders(flags.providers, providers)),
    ...(flags.roles ?? []).map((spec) => assignmentFromRoles(spec, providers)),
  ];
  const seen = new Set<string>();
  return all.filter((entry) => {
    if (seen.has(entry.label)) return false;
    seen.add(entry.label);
    return true;
  });
}

/**
 * `--model` values: `provider=name` for one provider, or a bare name for `claude` (what
 * `--model` meant before providers could be chosen).
 */
export function modelsFrom(values: readonly string[] | undefined): Record<string, string> {
  const models: Record<string, string> = {};
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at === -1) models.claude = value;
    else models[value.slice(0, at).trim()] = value.slice(at + 1).trim();
  }
  return models;
}

/** Failures that are a provider's limit (`HarnessError` kinds), as batch errors carry them. */
const LIMIT_ERROR = /\b(?:rate_limit|plan_limit):/;

/** Batch failures that were a rate or plan limit, including runs after the first. */
export function limitHits(scores: readonly FixtureScore[]): number {
  return scores.reduce((n, score) => {
    const errors = [...score.errors, ...(score.repeatErrors ?? [])];
    return n + errors.filter((error) => LIMIT_ERROR.test(error)).length;
  }, 0);
}

const ratio = z.number().min(0).max(1);

/** One configuration's result in the saved file: numbers only, no finding text. */
const configurationSchema = z
  .object({
    label: z.string(),
    roles: z.partialRecord(z.enum(ROLES), z.string()),
    /** The model each role's provider ran ("" is the harness's default). */
    models: z.partialRecord(z.enum(ROLES), z.string()),
    status: z.enum(["ran", "skipped"]),
    /** Why it didn't run: a provider without a credential. */
    skipped: z.string().optional(),
    totals: z
      .object({
        recall: ratio,
        falsePositiveRate: ratio,
        severityAccuracy: ratio,
        expected: z.number().int().min(0),
        found: z.number().int().min(0),
        falsePositives: z.number().int().min(0),
        costUsd: z.number().min(0),
        durationMs: z.number().min(0),
        failedRuns: z.number().int().min(0),
        limitHits: z.number().int().min(0),
      })
      .strict()
      .optional(),
    fixtures: z
      .array(
        z
          .object({
            name: z.string(),
            kind: z.enum(["seeded", "clean"]),
            found: z.number().int().min(0),
            expected: z.number().int().min(0),
            falsePositives: z.number().int().min(0),
            costUsd: z.number().min(0),
            durationMs: z.number().min(0),
            errors: z.array(z.string()),
            /** Failures from runs after the first. Absent when every later run succeeded. */
            repeatErrors: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * The saved matrix results (`matrix.json`). Versioned, so files kept from earlier runs can be
 * read back when choosing role defaults.
 */
export const matrixResultsSchema = z
  .object({
    version: z.literal(1),
    startedAt: z.string(),
    finishedAt: z.string(),
    /** The fixtures every configuration ran, by name. */
    fixtures: z.array(z.string()),
    configurations: z.array(configurationSchema),
  })
  .strict();

export type MatrixResults = z.infer<typeof matrixResultsSchema>;
export type MatrixConfiguration = z.infer<typeof configurationSchema>;

export interface MatrixOptions {
  providers: Readonly<Record<string, EvalProvider>>;
  /** Where the credentials come from. */
  env: Readonly<Record<string, string | undefined>>;
  /** A harness for a provider, for one configuration (its transcripts kept apart). */
  harnessFor(provider: EvalProvider, assignment: Assignment): Harness;
  /** `--model` per provider (see `modelsFrom`); a provider left out runs its default. */
  models: Readonly<Record<string, string>>;
  batchTimeoutMs: number;
  /** How many times to run each fixture. Unset runs each once. */
  repeat?: number;
  workRoot: string;
  progress?: (line: string) => void;
  /** Each ran configuration's full report, to write next to the results. */
  onReport?: (assignment: Assignment, report: EvalReport) => Promise<void>;
  now?: () => Date;
}

/**
 * Runs the same fixtures on each configuration, one after another. A configuration whose provider
 * has no credential is skipped with the reason; a limit hit is a failed batch, counted, and the
 * run goes on.
 */
export async function runMatrix(
  fixtures: readonly Fixture[],
  assignments: readonly Assignment[],
  options: MatrixOptions,
): Promise<MatrixResults> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const configurations: MatrixConfiguration[] = [];
  for (const assignment of assignments) {
    const models: Partial<Record<Role, string>> = {};
    let skipped: string | undefined;
    for (const role of ROLES) {
      const id = assignment.roles[role];
      if (id === undefined) continue;
      const provider = options.providers[id];
      if (provider === undefined) throw new Error(`Unknown provider ${id}.`);
      models[role] = options.models[id] ?? provider.defaultModel;
      const problem = provider.unavailable(options.env);
      if (problem !== undefined && skipped === undefined) skipped = `${id}: ${problem}`;
    }
    const base = { label: assignment.label, roles: assignment.roles, models };
    if (skipped !== undefined) {
      options.progress?.(`Skipping ${assignment.label}: ${skipped}`);
      configurations.push({ ...base, status: "skipped", skipped });
      continue;
    }
    const reviewer = options.providers[assignment.roles.reviewer ?? ""];
    if (reviewer === undefined) throw new Error(`${assignment.label} has no reviewer.`);
    options.progress?.(`Running ${assignment.label}…`);
    const model = models.reviewer ?? "";
    const scores = await runFixtures(fixtures, {
      harness: options.harnessFor(reviewer, assignment),
      model,
      batchTimeoutMs: options.batchTimeoutMs,
      workRoot: options.workRoot,
      ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    });
    const report = buildReport(scores, model, startedAt);
    await options.onReport?.(assignment, report);
    configurations.push({
      ...base,
      status: "ran",
      totals: { ...report.totals, limitHits: limitHits(scores) },
      fixtures: scores.map((score) => ({
        name: score.name,
        kind: score.kind,
        found: score.matched.length,
        expected: score.expected,
        falsePositives: score.falsePositives.length,
        costUsd: score.costUsd,
        durationMs: score.durationMs,
        errors: [...score.errors],
        ...(score.repeatErrors === undefined || score.repeatErrors.length === 0
          ? {}
          : { repeatErrors: [...score.repeatErrors] }),
      })),
    });
  }
  return matrixResultsSchema.parse({
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    fixtures: fixtures.map((fixture) => fixture.name),
    configurations,
  });
}

/** Whether the matrix measured anything: some configuration ran a fixture without failing. */
export function matrixRan(results: MatrixResults): boolean {
  return results.configurations.some(
    (entry) =>
      entry.totals !== undefined && entry.totals.failedRuns < (entry.fixtures?.length ?? 0),
  );
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/**
 * The side-by-side table, as Markdown. Labels and skip reasons are escaped: a reason is a
 * harness's message.
 */
export function renderMatrixMarkdown(results: MatrixResults): string {
  const lines = [
    "## LGTMoose provider matrix",
    "",
    `${results.fixtures.length} fixtures on each configuration.`,
    "",
    "| Configuration | Models | Recall | False-positive rate | Cost | Time | Limit hits | Failed runs |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of results.configurations) {
    const models = Object.entries(entry.models)
      .map(([role, model]) => `${role} ${inline(model === "" ? "default" : model)}`)
      .join(", ");
    const t = entry.totals;
    if (t === undefined) {
      lines.push(
        `| ${inline(entry.label)} | ${models} | skipped: ${inline(entry.skipped ?? "")} | | | | | |`,
      );
      continue;
    }
    lines.push(
      `| ${inline(entry.label)} | ${models} | ${percent(t.recall)} (${t.found}/${t.expected}) | ${percent(t.falsePositiveRate)} | $${t.costUsd.toFixed(2)} | ${Math.round(t.durationMs / 100) / 10}s | ${t.limitHits} | ${t.failedRuns} |`,
    );
  }
  const partial = results.configurations.filter((entry) => (entry.totals?.failedRuns ?? 0) > 0);
  const later = results.configurations.some((entry) =>
    entry.fixtures?.some((fixture) => (fixture.repeatErrors?.length ?? 0) > 0),
  );
  if (later) {
    lines.push(
      "",
      "A later run failed on a row above. Recall stays the first run. See each configuration's report.md.",
    );
  }
  if (partial.length > 0) {
    lines.push(
      "",
      "⚠️ Failed runs count as misses on seeded fixtures, so recall on a row with failed runs is a lower bound. See each configuration's report.md for the errors.",
    );
  }
  return `${lines.join("\n")}\n`;
}
