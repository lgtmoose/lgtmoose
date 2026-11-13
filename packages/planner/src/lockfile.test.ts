import type { FileDiff, Hunk } from "@lgtmoose/git";
import { describe, expect, it } from "vitest";
import { lockfileNotes } from "./lockfile.js";

function lockfile(removed: string[], added: string[]): FileDiff {
  let oldLine = 10;
  let newLine = 10;
  const hunk: Hunk = {
    oldStart: 10,
    oldLines: removed.length,
    newStart: 10,
    newLines: added.length,
    section: "",
    lines: [
      ...removed.map((text) => ({ kind: "del" as const, oldLine: oldLine++, text })),
      ...added.map((text) => ({ kind: "add" as const, newLine: newLine++, text })),
    ],
  };
  return {
    path: "package-lock.json",
    status: "modified",
    oldBlob: "a".repeat(40),
    newBlob: "b".repeat(40),
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: [hunk],
  };
}

const RESOLVED = (host: string) =>
  `      "resolved": "https://${host}/left-pad/-/left-pad-1.3.0.tgz",`;

describe("lockfileNotes", () => {
  it("notes a package resolved from an unknown host", () => {
    const file = lockfile(
      [RESOLVED("registry.npmjs.org"), '      "integrity": "sha512-AAA",'],
      [RESOLVED("evil.example.com"), '      "integrity": "sha512-BBB",'],
    );
    expect(lockfileNotes(file)).toEqual([
      "line 10: resolves from evil.example.com, not a known registry",
      "lines 10-11: a checksum changed with no version change",
    ]);
  });

  it("notes a checksum change for the same version", () => {
    const file = lockfile(
      ['      "integrity": "sha512-AAA",'],
      ['      "integrity": "sha512-BBB",'],
    );
    expect(lockfileNotes(file)).toEqual(["lines 10-10: a checksum changed with no version change"]);
  });

  it("is quiet for an ordinary version bump from the registry", () => {
    const file = lockfile(
      [
        '      "version": "1.3.0",',
        RESOLVED("registry.npmjs.org"),
        '      "integrity": "sha512-AAA",',
      ],
      [
        '      "version": "1.3.1",',
        '      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.1.tgz",',
        '      "integrity": "sha512-BBB",',
      ],
    );
    expect(lockfileNotes(file)).toEqual([]);
  });

  it("notes git and ssh sources", () => {
    const file = lockfile([], ['  dep: "git+ssh://git@gitlab.example.org/team/dep.git#abc"']);
    expect(lockfileNotes(file)).toEqual([
      "line 10: resolves from gitlab.example.org, not a known registry",
    ]);
  });
});
