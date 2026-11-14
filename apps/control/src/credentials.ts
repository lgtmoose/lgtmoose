import { assertRunId, runKeys } from "@lgtmoose/pipeline";
import { z } from "zod";
import type { ArtifactStore } from "./ports.js";

/**
 * The credential broker (NIC-825). Each sandbox task already gets only its own provider's
 * credential: one task definition per provider, with that one secret. The broker adds what
 * happens around a task:
 *
 * - **Leases.** Before a sandbox task starts, its batch takes one of the credential's slots
 *   (`credentialConcurrency` of them, across every review); after the task it gives it back.
 *   No free slot: `CredentialBusyError`, and the state machine waits and asks again.
 * - **Refreshed tokens.** A ChatGPT sign-in has one slot. When Codex refreshes it during a run,
 *   the sandbox writes the new `auth.json` to the batch's `credential.json`; the broker stores it
 *   in the provider's secret only while the batch still holds its lease, only when the secret
 *   hasn't changed since the lease was taken, and only for the same ChatGPT account. The object
 *   is deleted either way.
 * - **Audit.** Every lease taken, taken over, given back and every stored refresh is logged with
 *   the run, the batch, the slot and the secret's version: never a value.
 * - **Health.** A credential problem (missing, being deleted, a Claude token near its year's
 *   end, a run refused for auth) is a `CredentialProblem` metric of 1 for the provider, which
 *   alarms; a check that finds none reports 0.
 */

/** The lease objects' prefix in the artifact bucket. */
export const LEASE_PREFIX = "credentials/leases/";

/** One provider's credential, as the broker Lambdas are configured with it. */
export interface BrokerCredential {
  /** The provider's secret: its name or ARN. */
  secretId: string;
  /** The provider's `auth`, such as `chatgpt-login`. */
  auth: string;
  /** How many tasks may hold it at once (`credentialConcurrency`). */
  limit: number;
}

export const brokerCredentialsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z
    .object({
      secretId: z.string().min(1),
      auth: z.string().min(1),
      limit: z.number().int().min(1).max(64),
    })
    .strict(),
);

/** The provider's secret, without its value except where a refresh needs it. */
export interface CredentialSecrets {
  /**
   * The secret's state: whether it exists and isn't scheduled for deletion, its current version
   * (AWSCURRENT) and when that version was created.
   */
  describe(secretId: string): Promise<{
    exists: boolean;
    deleting: boolean;
    currentVersion: string | undefined;
    currentSince: Date | undefined;
  }>;
  /** The current value. Only read to check a refresh is for the same account. */
  read(secretId: string): Promise<string>;
  /** Stores `value` as the new current version; `requestToken` makes a retry a no-op. */
  write(secretId: string, value: string, requestToken: string): Promise<string>;
}

export interface BrokerDeps {
  store: Pick<ArtifactStore, "createText" | "replaceText" | "getTagged" | "deleteIfMatch">;
  secrets: CredentialSecrets;
  /** Whether a Step Functions execution is still running (a lease's holder). */
  executionRunning(executionArn: string): Promise<boolean>;
  credentials: Readonly<Record<string, BrokerCredential>>;
  /** How long a lease lasts without being given back: longer than a sandbox task may run. */
  leaseTtlMs: number;
  now(): number;
  /** A fresh random token, unique to one lease. */
  newToken(): string;
  /** Where the first slot to try is: spreads tasks across slots. */
  random(): number;
  /** The audit log: one line per event, never a credential. */
  audit(event: string, fields: Record<string, unknown>): void;
  /** `CredentialProblem` for a provider: 1 with a reason, or 0 when it's fine. */
  problem(providerId: string, value: 0 | 1, reason?: string): void;
}

/** No slot is free: the state machine waits and asks again. Its name is the error it matches. */
export class CredentialBusyError extends Error {
  constructor(providerId: string, limit: number) {
    super(`All ${limit} of ${providerId}'s credential slots are in use.`);
    this.name = "Lgtmoose.CredentialBusy";
  }
}

/** The credential can't be used at all (missing, being deleted): the batch fails, and alarms. */
export class CredentialUnavailableError extends Error {
  constructor(providerId: string, reason: string) {
    super(`${providerId}'s credential can't be used: ${reason}.`);
    this.name = "Lgtmoose.CredentialUnavailable";
  }
}

const leaseSchema = z
  .object({
    /** Unique to this lease: the object's body is ours only while it names this. */
    holder: z.string().min(16),
    runId: z.string(),
    index: z.number().int().min(0),
    executionArn: z.string(),
    /** The secret's current version when the lease was taken: what the task was started with. */
    versionId: z.string(),
    takenAt: z.number(),
    expiresAt: z.number(),
  })
  .strict();

export type Lease = z.infer<typeof leaseSchema>;

/** What the acquire step returns, for the release step after the task. */
export interface HeldLease {
  slot: number;
  holder: string;
}

const batchRefSchema = z
  .object({
    providerId: z.string(),
    runId: z.string().refine((id) => {
      try {
        assertRunId(id);
        return true;
      } catch {
        return false;
      }
    }, "not a run ID"),
    index: z.number().int().min(0),
  })
  .strict();

export const acquireEventSchema = batchRefSchema
  .extend({ action: z.literal("acquire"), executionArn: z.string().min(1) })
  .strict();
export const releaseEventSchema = batchRefSchema
  .extend({
    action: z.literal("release"),
    lease: z.object({ slot: z.number().int().min(0), holder: z.string().min(16) }).strict(),
  })
  .strict();
export const brokerEventSchema = z.discriminatedUnion("action", [
  acquireEventSchema,
  releaseEventSchema,
]);
export type AcquireEvent = z.infer<typeof acquireEventSchema>;
export type ReleaseEvent = z.infer<typeof releaseEventSchema>;

export function leaseKey(providerId: string, slot: number): string {
  return `${LEASE_PREFIX}${providerId}/${slot}.json`;
}

function credentialOf(deps: BrokerDeps, providerId: string): BrokerCredential {
  const credential = deps.credentials[providerId];
  if (credential === undefined) throw new Error(`No credential is configured for ${providerId}.`);
  return credential;
}

function parseLease(text: string): Lease | undefined {
  try {
    const parsed = leaseSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Why a credential can't be used right now, from its secret's state; undefined when it can. */
function unavailable(
  state: Awaited<ReturnType<CredentialSecrets["describe"]>>,
): string | undefined {
  if (!state.exists) return "its secret doesn't exist (run lgtmoose auth)";
  if (state.deleting) return "its secret is scheduled for deletion";
  if (state.currentVersion === undefined) return "its secret has no current version";
  return undefined;
}

/**
 * Takes one of the credential's slots for a batch. A slot is free when there's no lease object,
 * or its lease has expired, is unreadable, belongs to an earlier attempt of the same batch, or
 * belongs to an execution that's no longer running (stopped by a newer push, say). A slot is
 * taken with a conditional write, so two batches can't both take it. Taking over a stopped
 * holder's slot first stores that holder's refreshed credential, if it left one.
 */
export async function acquireLease(deps: BrokerDeps, event: AcquireEvent): Promise<HeldLease> {
  const { providerId, runId, index, executionArn } = acquireEventSchema.parse(event);
  const credential = credentialOf(deps, providerId);
  const state = await deps.secrets.describe(credential.secretId);
  const reason = unavailable(state);
  if (reason !== undefined || state.currentVersion === undefined) {
    deps.problem(providerId, 1, reason);
    throw new CredentialUnavailableError(providerId, reason ?? "unknown");
  }
  const now = deps.now();
  const lease: Lease = {
    holder: deps.newToken(),
    runId,
    index,
    executionArn,
    versionId: state.currentVersion,
    takenAt: now,
    expiresAt: now + deps.leaseTtlMs,
  };
  const body = JSON.stringify(lease);
  const first = Math.floor(deps.random() * credential.limit) % credential.limit;
  const slots = Array.from({ length: credential.limit }, (_, i) => (first + i) % credential.limit);
  const taken = (slot: number, previous?: Lease): HeldLease => {
    deps.audit(previous === undefined ? "credential lease taken" : "credential lease taken over", {
      providerId,
      runId,
      index,
      slot,
      versionId: lease.versionId,
      executionArn,
      ...(previous === undefined
        ? {}
        : { previousRunId: previous.runId, previousIndex: previous.index }),
    });
    return { slot, holder: lease.holder };
  };

  // Free slots first: one conditional write each, no reads.
  const busy: number[] = [];
  for (const slot of slots) {
    if ((await deps.store.createText(leaseKey(providerId, slot), body)) !== undefined) {
      return taken(slot);
    }
    busy.push(slot);
  }
  // Every slot has a lease: take one whose holder is done.
  for (const slot of busy) {
    const key = leaseKey(providerId, slot);
    const current = await deps.store.getTagged(key);
    if (current === undefined) {
      if ((await deps.store.createText(key, body)) !== undefined) return taken(slot);
      continue;
    }
    const held = parseLease(current.text);
    const done =
      held === undefined ||
      held.expiresAt <= deps.now() ||
      (held.runId === runId && held.index === index) ||
      !(await deps.executionRunning(held.executionArn));
    if (!done) continue;
    if ((await deps.store.replaceText(key, body, current.etag)) === undefined) continue;
    if (held !== undefined && credential.auth === "chatgpt-login") {
      await storeRefresh(deps, providerId, credential, held);
    }
    return taken(slot, held);
  }
  throw new CredentialBusyError(providerId, credential.limit);
}

/**
 * Gives a batch's slot back after its task, whatever the task did. While the batch still holds
 * it, a ChatGPT sign-in's refreshed `auth.json` is stored first; a batch whose lease was taken
 * over since (it ran past its lease) stores nothing, and its refresh is deleted. A run that
 * failed for auth reports a credential problem.
 */
export async function releaseLease(
  deps: BrokerDeps,
  event: ReleaseEvent,
  /** The batch's output, if it wrote one: to tell an auth failure. */
  output: string | undefined,
): Promise<void> {
  const { providerId, runId, index, lease } = releaseEventSchema.parse(event);
  const credential = credentialOf(deps, providerId);
  const key = leaseKey(providerId, lease.slot);
  const current = await deps.store.getTagged(key);
  const held = current === undefined ? undefined : parseLease(current.text);
  const ours =
    held !== undefined &&
    held.holder === lease.holder &&
    held.runId === runId &&
    held.index === index;
  let stored: string | undefined;
  if (credential.auth === "chatgpt-login") {
    if (ours && held !== undefined) {
      stored = await storeRefresh(deps, providerId, credential, held);
    } else {
      await dropRefresh(deps, runId, index, providerId, "the batch no longer holds its lease");
    }
  }
  if (authFailed(output)) {
    deps.problem(providerId, 1, "a review run was refused for auth");
  }
  if (ours && current !== undefined) await deps.store.deleteIfMatch(key, current.etag);
  deps.audit("credential lease given back", {
    providerId,
    runId,
    index,
    slot: lease.slot,
    held: ours,
    ...(held === undefined ? {} : { versionId: held.versionId }),
    ...(stored === undefined ? {} : { storedVersionId: stored }),
  });
}

/** A batch output whose error is the harness's `auth` failure (`errorText` in the pipeline). */
function authFailed(output: string | undefined): boolean {
  if (output === undefined) return false;
  try {
    const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(output));
    return parsed.success && parsed.data.error.startsWith("auth:");
  } catch {
    return false;
  }
}

/** The largest refreshed `auth.json` accepted; real ones are a few KB. */
const MAX_REFRESH_BYTES = 16 * 1024;

const authJsonSchema = z.looseObject({
  tokens: z.looseObject({
    refresh_token: z.string().min(1),
    access_token: z.string().min(1),
    account_id: z.string().optional(),
  }),
});

function accountOf(text: string): string | undefined {
  try {
    const parsed = authJsonSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data.tokens.account_id ?? "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores the refreshed `auth.json` a lease's batch left, and deletes it. It's stored only when
 * it's a sign-in's `auth.json`, the secret is still the version the batch started with (so a
 * newer refresh or a new `lgtmoose auth` isn't overwritten), and it's for the same ChatGPT
 * account. Returns the new version's ID, when stored.
 */
async function storeRefresh(
  deps: BrokerDeps,
  providerId: string,
  credential: BrokerCredential,
  lease: Lease,
): Promise<string | undefined> {
  const key = runKeys(lease.runId).batchCredential(lease.index);
  const object = await deps.store.getTagged(key);
  if (object === undefined) return undefined;
  const fields = { providerId, runId: lease.runId, index: lease.index };
  try {
    const refreshed = object.text;
    const account =
      Buffer.byteLength(refreshed) <= MAX_REFRESH_BYTES ? accountOf(refreshed) : undefined;
    if (account === undefined) {
      deps.audit("refreshed credential not stored: not a sign-in's auth.json", fields);
      deps.problem(providerId, 1, "a task handed back a credential that isn't an auth.json");
      return undefined;
    }
    const state = await deps.secrets.describe(credential.secretId);
    if (state.currentVersion !== lease.versionId) {
      deps.audit("refreshed credential not stored: the secret changed since the task started", {
        ...fields,
        versionId: lease.versionId,
        currentVersionId: state.currentVersion,
      });
      return undefined;
    }
    const before = accountOf(await deps.secrets.read(credential.secretId));
    if (before !== account) {
      deps.audit("refreshed credential not stored: it's for another account", fields);
      deps.problem(providerId, 1, "a task handed back a credential for another account");
      return undefined;
    }
    const versionId = await deps.secrets.write(credential.secretId, refreshed, lease.holder);
    deps.audit("refreshed credential stored", {
      ...fields,
      previousVersionId: lease.versionId,
      versionId,
    });
    return versionId;
  } finally {
    await deps.store.deleteIfMatch(key, object.etag);
  }
}

async function dropRefresh(
  deps: BrokerDeps,
  runId: string,
  index: number,
  providerId: string,
  reason: string,
): Promise<void> {
  const key = runKeys(runId).batchCredential(index);
  const object = await deps.store.getTagged(key);
  if (object === undefined) return;
  await deps.store.deleteIfMatch(key, object.etag);
  deps.audit(`refreshed credential not stored: ${reason}`, { providerId, runId, index });
}

/** `claude setup-token` tokens last a year; this long after storing one, it's flagged. */
export const OAUTH_TOKEN_WARN_AFTER_MS = 330 * 24 * 60 * 60 * 1000;

/**
 * The scheduled health check: each credential's secret is described (never read), and its
 * `CredentialProblem` reported: 1 when it's missing, scheduled for deletion, without a current
 * version, or a Claude `oauth-token` stored long enough ago to expire soon; else 0. Tokens
 * revoked or expired early show up as runs refused for auth (`releaseLease`).
 */
export async function checkCredentials(
  deps: Pick<BrokerDeps, "secrets" | "credentials" | "now" | "problem">,
): Promise<Record<string, string | undefined>> {
  const results: Record<string, string | undefined> = {};
  for (const [providerId, credential] of Object.entries(deps.credentials)) {
    let reason: string | undefined;
    try {
      const state = await deps.secrets.describe(credential.secretId);
      reason = unavailable(state);
      if (
        reason === undefined &&
        credential.auth === "oauth-token" &&
        state.currentSince !== undefined &&
        deps.now() - state.currentSince.getTime() >= OAUTH_TOKEN_WARN_AFTER_MS
      ) {
        reason = "its Claude token was stored nearly a year ago and expires soon";
      }
    } catch (error) {
      reason = `its secret couldn't be described (${error instanceof Error ? error.name : "error"})`;
    }
    deps.problem(providerId, reason === undefined ? 0 : 1, reason);
    results[providerId] = reason;
  }
  return results;
}
