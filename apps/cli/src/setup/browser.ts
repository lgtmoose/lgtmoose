import { spawn } from "node:child_process";

/** The platform's "open this URL" command. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // The empty string is `start`'s window title, so the URL isn't mistaken for one.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""', url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Opens a URL in the default browser. Resolves false instead of throwing when there's no
 * browser (SSH sessions, containers), since setup prints the URL anyway.
 */
export function openBrowser(url: string): Promise<boolean> {
  const { command, args } = openCommand(url);
  return new Promise((resolve) => {
    try {
      // Verbatim arguments so cmd.exe sees `start "" <url>` rather than escaped quotes. Setup
      // only ever opens its own http://127.0.0.1:<port>/ URL, which has no characters cmd treats
      // specially.
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
        windowsVerbatimArguments: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
