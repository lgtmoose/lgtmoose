// Run with `node --test tools/release/release-notes.test.mjs` (the release workflow does).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changelogSection, releaseNotes } from "./release-notes.mjs";

const digest = (c) => `sha256:${c.repeat(64)}`;
const digests = { control: digest("a"), sandbox: digest("b"), egressProxy: digest("c") };

const CHANGELOG = `# lgtmoose

## 0.2.0

### Minor Changes

- abc123: Adds a thing.

## 0.1.0

### Minor Changes

- def456: The first release.
`;

describe("changelogSection", () => {
  it("takes one version's section", () => {
    assert.equal(
      changelogSection(CHANGELOG, "0.2.0"),
      "### Minor Changes\n\n- abc123: Adds a thing.",
    );
    assert.equal(
      changelogSection(CHANGELOG, "0.1.0"),
      "### Minor Changes\n\n- def456: The first release.",
    );
  });

  it("is undefined for a version that isn't there", () => {
    assert.equal(changelogSection(CHANGELOG, "9.9.9"), undefined);
  });
});

describe("releaseNotes", () => {
  it("lists each image by digest, how to verify it and the config that deploys it", () => {
    const notes = releaseNotes({ tag: "v0.2.0", owner: "lgtmoose", digests, changelog: CHANGELOG });
    assert.match(notes, /Adds a thing\./);
    assert.doesNotMatch(notes, /The first release\./);
    assert.match(notes, new RegExp(`ghcr\\.io/lgtmoose/lgtmoose-sandbox\` \\| \`${digest("b")}`));
    assert.match(
      notes,
      new RegExp(
        `gh attestation verify oci://ghcr\\.io/lgtmoose/lgtmoose-control@${digest("a")} --repo lgtmoose/lgtmoose`,
      ),
    );
    assert.match(notes, /source: "release",/);
    assert.match(notes, /version: "0\.2\.0",/);
    assert.match(notes, new RegExp(`egressProxy: "${digest("c")}",`));
    // Never a tag: the config pins digests.
    assert.doesNotMatch(notes, /lgtmoose-control:v0\.2\.0/);
  });

  it("refuses something that isn't a digest", () => {
    assert.throws(
      () =>
        releaseNotes({
          tag: "v0.2.0",
          owner: "lgtmoose",
          digests: { ...digests, sandbox: "latest" },
          changelog: "",
        }),
      /sandbox's digest/,
    );
  });

  it("points at the changelog when the version has no section", () => {
    const notes = releaseNotes({ tag: "v0.3.0", owner: "lgtmoose", digests, changelog: "" });
    assert.match(notes, /^See CHANGELOG\.md\./);
  });
});
