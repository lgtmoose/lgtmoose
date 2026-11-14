import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAuthJson, codexLogin, CodexLoginError, LoginInterrupted } from "./codex-login.js";
import { CommandNotFound, type InteractiveRunner, type SignalTrap } from "./process.js";

const AUTH_JSON = JSON.stringify({ tokens: { refresh_token: "SECRET-REFRESH" } });
const noTrap: SignalTrap = () => () => {};

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lgtmoose-codex-test-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("codexLogin", () => {
  it("logs in to a private CODEX_HOME that keeps auth in a file, and removes it", async () => {
    let seen: { mode: number; config: string } | undefined;
    const run: InteractiveRunner = async (_command, args, { env }) => {
      const home = env?.CODEX_HOME ?? "";
      seen = {
        mode: (await stat(home)).mode & 0o777,
        config: await readFile(join(home, "config.toml"), "utf8"),
      };
      expect(args).toEqual(["login"]);
      await writeFile(join(home, "auth.json"), AUTH_JSON);
      return 0;
    };
    const untrapped: string[] = [];
    const trap: SignalTrap = () => () => untrapped.push("off");
    const result = await codexLogin({ run, trapSignals: trap, deviceAuth: false, tmpRoot });
    expect(result).toBe(AUTH_JSON);
    expect(seen).toEqual({ mode: 0o700, config: 'cli_auth_credentials_store = "file"\n' });
    expect(untrapped).toEqual(["off"]);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("removes the directory when codex fails or writes nothing", async () => {
    const failing: InteractiveRunner = async (_c, _a, { env }) => {
      await writeFile(join(env?.CODEX_HOME ?? "", "auth.json"), AUTH_JSON);
      return 2;
    };
    await expect(
      codexLogin({ run: failing, trapSignals: noTrap, deviceAuth: false, tmpRoot }),
    ).rejects.toThrow("exited with code 2");
    await expect(
      codexLogin({ run: async () => 0, trapSignals: noTrap, deviceAuth: false, tmpRoot }),
    ).rejects.toThrow("wrote no auth.json");
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("stops on a signal, still removing the directory", async () => {
    let fire: (() => void) | undefined;
    let force: (() => void) | undefined;
    const trap: SignalTrap = (onSignal, forceCleanup) => {
      fire = onSignal;
      force = forceCleanup;
      return () => {};
    };
    const run: InteractiveRunner = async (_c, _a, { env, signal }) => {
      await writeFile(join(env?.CODEX_HOME ?? "", "auth.json"), AUTH_JSON);
      fire?.();
      expect(signal?.aborted).toBe(true);
      return null;
    };
    await expect(codexLogin({ run, trapSignals: trap, deviceAuth: true, tmpRoot })).rejects.toThrow(
      LoginInterrupted,
    );
    expect(await readdir(tmpRoot)).toEqual([]);
    // The second-signal path removes the directory synchronously, and is safe after cleanup.
    expect(() => force?.()).not.toThrow();
  });

  it("a Ctrl+C after codex exits still stops the upload, and still removes the directory", async () => {
    let fire: (() => void) | undefined;
    const trap: SignalTrap = (onSignal) => {
      fire = onSignal;
      return () => {
        fire = undefined;
      };
    };
    const run: InteractiveRunner = async (_c, _a, { env }) => {
      await writeFile(join(env?.CODEX_HOME ?? "", "auth.json"), AUTH_JSON);
      // codex is done; the Ctrl+C lands after it exits, while auth.json is being read.
      setImmediate(() => fire?.());
      return 0;
    };
    await expect(
      codexLogin({ run, trapSignals: trap, deviceAuth: false, tmpRoot }),
    ).rejects.toThrow(LoginInterrupted);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("removes the directory before it stops watching for signals", async () => {
    const order: string[] = [];
    const trap: SignalTrap = () => () => order.push(`untrap:${String(dirLeft())}`);
    let home = "";
    const dirLeft = () => home !== "" && existsSync(home);
    const run: InteractiveRunner = async (_c, _a, { env }) => {
      home = env?.CODEX_HOME ?? "";
      await writeFile(join(home, "auth.json"), AUTH_JSON);
      return 0;
    };
    await codexLogin({ run, trapSignals: trap, deviceAuth: false, tmpRoot });
    expect(order).toEqual(["untrap:false"]);
  });

  it("stops watching for signals even when the removal fails", async () => {
    const untrapped: string[] = [];
    const trap: SignalTrap = () => () => untrapped.push("off");
    const run: InteractiveRunner = async (_c, _a, { env }) => {
      await writeFile(join(env?.CODEX_HOME ?? "", "auth.json"), AUTH_JSON);
      return 0;
    };
    const removeDir = () => Promise.reject(new Error("EBUSY"));
    await expect(
      codexLogin({ run, trapSignals: trap, deviceAuth: false, tmpRoot, removeDir }),
    ).rejects.toThrow("EBUSY");
    expect(untrapped).toEqual(["off"]);
  });

  it("keeps the real error when the removal also fails, and names the leftover directory", async () => {
    const run: InteractiveRunner = async () => 3;
    const removeDir = () => Promise.reject(new Error("EACCES"));
    const error = await codexLogin({
      run,
      trapSignals: noTrap,
      deviceAuth: false,
      tmpRoot,
      removeDir,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexLoginError);
    expect(String(error)).toContain("exited with code 3");
    expect(String(error)).toMatch(/couldn't delete .*lgtmoose-codex-auth-.*EACCES/);
  });

  it("keeps the real error's type when the removal also fails", async () => {
    const original = new CommandNotFound("codex isn't installed, or isn't on your PATH.");
    const run: InteractiveRunner = () => Promise.reject(original);
    const removeDir = () => Promise.reject(new Error("EACCES"));
    const error = await codexLogin({
      run,
      trapSignals: noTrap,
      deviceAuth: false,
      tmpRoot,
      removeDir,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandNotFound);
    expect(String(error)).toContain("codex isn't installed");
    expect(String(error)).toContain("EACCES");
    // A new error with the original as its cause; the original is left as it was.
    expect((error as Error).cause).toBe(original);
    expect(original.message).toBe("codex isn't installed, or isn't on your PATH.");
  });

  it("a Ctrl+C wins over an error reading auth.json", async () => {
    let fire: (() => void) | undefined;
    const trap: SignalTrap = (onSignal) => {
      fire = onSignal;
      return () => {};
    };
    // codex exits 0 having written nothing; the Ctrl+C lands while auth.json is being read.
    const run: InteractiveRunner = async () => {
      setImmediate(() => fire?.());
      return 0;
    };
    await expect(
      codexLogin({ run, trapSignals: trap, deviceAuth: false, tmpRoot }),
    ).rejects.toThrow(LoginInterrupted);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("the forced cleanup removes the directory on its own", async () => {
    const trap: SignalTrap = (_onSignal, forceCleanup) => {
      forceCleanup();
      return () => {};
    };
    const run: InteractiveRunner = async (_c, _a, { env }) => {
      // Gone already: the second signal removed it.
      await expect(stat(env?.CODEX_HOME ?? "")).rejects.toThrow();
      return null;
    };
    await expect(
      codexLogin({ run, trapSignals: trap, deviceAuth: false, tmpRoot }),
    ).rejects.toThrow();
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});

describe("checkAuthJson", () => {
  it("accepts a ChatGPT sign-in and rejects anything else without quoting it", () => {
    expect(() => checkAuthJson(AUTH_JSON)).not.toThrow();
    expect(() => checkAuthJson("{not json SECRET")).toThrow(CodexLoginError);
    const apiKeyOnly = JSON.stringify({ OPENAI_API_KEY: "sk-SECRET" });
    expect(() => checkAuthJson(apiKeyOnly)).toThrow("auth api-key --provider openai");
    try {
      checkAuthJson(apiKeyOnly);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
    }
  });
});
