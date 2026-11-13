import type { FileDiff, Hunk } from "@lgtmoose/git";
import { describe, expect, it } from "vitest";
import { lockfileNotes } from "./lockfile.js";

function lockfile(removed: string[], added: string[], path = "package-lock.json"): FileDiff {
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
    path,
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
      "1 package resolves from evil.example.com, not a known registry (first at line 10)",
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
      "1 package resolves from gitlab.example.org, not a known registry (first at line 10)",
    ]);
  });

  it("doesn't flag a Go dependency bump, where version and checksum share a line", () => {
    const file = lockfile(
      ["golang.org/x/net v0.20.0 h1:aaaa=", "golang.org/x/net v0.20.0/go.mod h1:bbbb="],
      ["golang.org/x/net v0.21.0 h1:cccc=", "golang.org/x/net v0.21.0/go.mod h1:dddd="],
      "go.sum",
    );
    expect(lockfileNotes(file)).toEqual([]);
  });

  it("flags a go.sum hash change for the same version", () => {
    const file = lockfile(
      ["golang.org/x/net v0.20.0 h1:aaaa="],
      ["golang.org/x/net v0.20.0 h1:zzzz="],
      "go.sum",
    );
    expect(lockfileNotes(file)).toEqual(["lines 10-10: a checksum changed with no version change"]);
  });

  it("ignores metadata URLs and Cargo's registry index", () => {
    const npm = lockfile(
      [],
      ['      "funding": {', '        "url": "https://github.com/sponsors/ljharb"', "      },"],
    );
    const cargo = lockfile(
      [],
      [
        'name = "serde"',
        'version = "1.0.1"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
      ],
      "Cargo.lock",
    );
    expect(lockfileNotes(npm)).toEqual([]);
    expect(lockfileNotes(cargo)).toEqual([]);
  });

  it("checks composer dist and source URLs, trusting the usual Git hosts there", () => {
    const composer = (host: string) =>
      lockfile(
        [],
        [
          '            "dist": {',
          '                "type": "zip",',
          `                "url": "https://${host}/repos/a/b/zipball/abc",`,
        ],
        "composer.lock",
      );
    expect(lockfileNotes(composer("api.github.com"))).toEqual([]);
    expect(lockfileNotes(composer("evil.example.com"))).toHaveLength(1);
  });

  it("groups packages by host and skips trusted registries", () => {
    const lines = Array.from({ length: 3 }, (_, i) =>
      RESOLVED("npm.acme.internal").replace("1.3.0", `1.3.${i}`),
    );
    expect(lockfileNotes(lockfile([], lines))).toEqual([
      "3 packages resolve from npm.acme.internal, not a known registry (first at line 10)",
    ]);
    expect(lockfileNotes(lockfile([], lines), { trustedHosts: ["npm.acme.internal"] })).toEqual([]);
  });
});
