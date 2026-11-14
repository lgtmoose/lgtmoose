import { spawn } from "node:child_process";

/**
 * Runs a vendor CLI attached to this terminal, so the person can sign in, and resolves with its
 * exit code (null when a signal ended it). Its output goes straight to the terminal: LGTMoose
 * never reads it. Rejects only when the command can't start.
 */
export type InteractiveRunner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<number | null>;

/**
 * Watches for Ctrl+C and termination signals while a sign-in runs. The first signal calls
 * `onSignal`, which should stop the sign-in so normal cleanup runs; a second calls
 * `forceCleanup` and exits at once. Returns a function that stops watching.
 */
export type SignalTrap = (onSignal: () => void, forceCleanup: () => void) => () => void;

export class CommandNotFound extends Error {
  override name = "CommandNotFound";
}

export const spawnInteractive: InteractiveRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: "inherit",
      env: options.env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new CommandNotFound(`${command} isn't installed, or isn't on your PATH.`));
      } else if (error.name === "AbortError") {
        // Aborting kills the child; its exit event settles the promise.
      } else {
        reject(error);
      }
    });
    child.once("exit", (code) => resolve(code));
  });

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export const trapProcessSignals: SignalTrap = (onSignal, forceCleanup) => {
  let seen = false;
  const handler = (signal: (typeof SIGNALS)[number]) => {
    if (!seen) {
      seen = true;
      onSignal();
      return;
    }
    try {
      forceCleanup();
    } finally {
      process.exit(EXIT_CODES[signal]);
    }
  };
  for (const signal of SIGNALS) process.on(signal, handler);
  return () => {
    for (const signal of SIGNALS) process.off(signal, handler);
  };
};
