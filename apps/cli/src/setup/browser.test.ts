import { describe, expect, it } from "vitest";
import { openCommand } from "./browser.js";

describe("openCommand", () => {
  const url = "http://127.0.0.1:4567/";

  it.each([
    ["darwin", { command: "open", args: [url] }],
    ["linux", { command: "xdg-open", args: [url] }],
    ["win32", { command: "cmd", args: ["/c", "start", '""', url] }],
  ] as const)("uses the %s opener", (platform, expected) => {
    expect(openCommand(url, platform)).toEqual(expected);
  });
});
