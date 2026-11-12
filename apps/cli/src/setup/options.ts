import { parseArgs } from "node:util";
import { deployConfigSchema } from "@lgtmoose/config";
import type { z } from "zod";
import type { Profile } from "./config-file.js";
import { MAX_APP_NAME_LENGTH, defaultAppName, type Owner, type OwnerKind } from "./manifest.js";
import type { Prompter } from "./prompter.js";

/** A mistake in what the person typed. Shown as-is, with exit code 1. */
export class UsageError extends Error {
  override name = "UsageError";
}

export interface SetupFlags {
  owner: Owner | undefined;
  appName: string | undefined;
  region: string | undefined;
  profile: Profile | undefined;
  /** Accept defaults and keep anything that already exists, without asking. */
  yes: boolean;
  help: boolean;
}

export interface SetupInputs {
  owner: Owner;
  appName: string;
  region: string;
  profile: Profile;
}

export const DEFAULT_REGION = "us-east-1";
export const DEFAULT_PROFILE: Profile = "lean";

// Reuse the deploy config's own rules, so setup accepts exactly what deploy will.
const { allowedOrgs, region, profile } = deployConfigSchema.shape;
const ownerSchema = allowedOrgs.element;
const regionSchema = region.unwrap();
const profileSchema = profile.unwrap();
export const PROFILES = profileSchema.options;

export const SETUP_HELP = `Usage: lgtmoose setup [options]

Creates the GitHub App, stores its keys in AWS Secrets Manager and writes lgtmoose.config.ts.
Asks for anything not given as a flag.

Options:
  --org <name>       Create the App in this GitHub organization
  --user <name>      Create the App in this personal GitHub account
  --app-name <name>  GitHub App name (default: lgtmoose-<org>)
  --region <region>  AWS region for the deployment and its secrets (default: ${DEFAULT_REGION})
  --profile <name>   ${PROFILES.join(" or ")} (default: ${DEFAULT_PROFILE})
  -y, --yes          Don't ask: use defaults and keep an existing App and config
  -h, --help         Show this help
`;

/** Returns the error message for a bad value, or undefined when it's fine. */
function problem(schema: z.ZodType, value: string): string | undefined {
  const result = schema.safeParse(value);
  return result.success ? undefined : (result.error.issues[0]?.message ?? "invalid value");
}

export function ownerProblem(login: string): string | undefined {
  return problem(ownerSchema, login);
}

export function regionProblem(value: string): string | undefined {
  return problem(regionSchema, value);
}

export function appNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "enter a name";
  if (name.length > MAX_APP_NAME_LENGTH) {
    return `GitHub allows at most ${MAX_APP_NAME_LENGTH} characters`;
  }
  return undefined;
}

function check(flag: string, value: string, problemOf: (value: string) => string | undefined) {
  const message = problemOf(value);
  if (message !== undefined) throw new UsageError(`--${flag} "${value}": ${message}`);
  return value;
}

export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        org: { type: "string" },
        user: { type: "string" },
        "app-name": { type: "string" },
        region: { type: "string" },
        profile: { type: "string" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;

  if (values.org !== undefined && values.user !== undefined) {
    throw new UsageError("Pass either --org or --user, not both.");
  }
  let owner: Owner | undefined;
  if (values.org !== undefined)
    owner = { login: check("org", values.org, ownerProblem), kind: "org" };
  if (values.user !== undefined) {
    owner = { login: check("user", values.user, ownerProblem), kind: "user" };
  }

  let profileValue: Profile | undefined;
  if (values.profile !== undefined) {
    const result = profileSchema.safeParse(values.profile);
    if (!result.success) {
      throw new UsageError(`--profile "${values.profile}": use ${PROFILES.join(" or ")}`);
    }
    profileValue = result.data;
  }

  const yes = values.yes ?? false;
  const help = values.help ?? false;
  if (yes && owner === undefined && !help) {
    throw new UsageError("--yes needs --org <name> or --user <name>, because there's no default.");
  }

  return {
    owner,
    appName:
      values["app-name"] === undefined
        ? undefined
        : check("app-name", values["app-name"], appNameProblem),
    region: values.region === undefined ? undefined : check("region", values.region, regionProblem),
    profile: profileValue,
    yes,
    help,
  };
}

/** For inquirer: `true` when valid, otherwise the message to show under the prompt. */
function validator(problemOf: (value: string) => string | undefined) {
  return (value: string): true | string => problemOf(value.trim()) ?? true;
}

/** Fills in whatever the flags left out: defaults with --yes, otherwise prompts. */
export async function resolveSetupInputs(
  flags: SetupFlags,
  prompter: Prompter,
): Promise<SetupInputs> {
  let owner = flags.owner;
  if (owner === undefined) {
    // parseSetupFlags already refuses --yes without an owner.
    const kind = await prompter.select<OwnerKind>({
      message: "Where should the GitHub App live?",
      choices: [
        { name: "A GitHub organization", value: "org" },
        { name: "My personal account", value: "user" },
      ],
      default: "org",
    });
    const login = await prompter.input({
      message: kind === "org" ? "Organization name" : "GitHub username",
      validate: validator(ownerProblem),
    });
    owner = { login: login.trim(), kind };
  }

  const appName =
    flags.appName ??
    (flags.yes
      ? defaultAppName(owner.login)
      : (
          await prompter.input({
            message: "GitHub App name (must be unique on GitHub)",
            default: defaultAppName(owner.login),
            validate: validator(appNameProblem),
          })
        ).trim());

  const regionValue =
    flags.region ??
    (flags.yes
      ? DEFAULT_REGION
      : (
          await prompter.input({
            message: "AWS region",
            default: DEFAULT_REGION,
            validate: validator(regionProblem),
          })
        ).trim());

  const profileValue =
    flags.profile ??
    (flags.yes
      ? DEFAULT_PROFILE
      : await prompter.select<Profile>({
          message: "Deployment profile",
          choices: [
            { name: "lean: lowest cost, single-AZ RDS and a NAT instance", value: "lean" },
            { name: "standard: Aurora across two AZs and NAT gateways", value: "standard" },
          ],
          default: DEFAULT_PROFILE,
        }));

  return { owner, appName, region: regionValue, profile: profileValue };
}
