import type { z } from "zod";

export interface ConfigIssue {
  /** Dotted path to the bad key, e.g. `providers[1].auth`. Empty for the root. */
  path: string;
  message: string;
}

/** Thrown when a config file fails validation. The message names every bad key. */
export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly ConfigIssue[];

  constructor(source: string, issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`);
    super(`${source} is invalid:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.source = source;
    this.issues = issues;
  }
}

export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === "number") return `${out}[${key}]`;
    const name = String(key);
    return out ? `${out}.${name}` : name;
  }, "");
}

export function toConfigError(source: string, error: z.ZodError): ConfigError {
  return new ConfigError(
    source,
    error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
  );
}
