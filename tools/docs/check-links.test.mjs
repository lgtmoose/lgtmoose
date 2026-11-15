import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchors, check, links, slug } from "./check-links.mjs";

test("slugs headings as GitHub does", () => {
  assert.equal(
    slug("GitHub: do App approvals count towards required reviews?"),
    "github-do-app-approvals-count-towards-required-reviews",
  );
  assert.equal(slug("`lgtmoose.config.ts`: the deployment"), "lgtmooseconfigts-the-deployment");
  assert.equal(
    slug("Bedrock with AWS credits (the default)"),
    "bedrock-with-aws-credits-the-default",
  );
});

test("finds headings and links outside code", () => {
  const text =
    "# Title\n\n```\n# not a heading\n[x](nope.md)\n```\n\nSee [a](b.md#c) and `[d](e.md)`.\n";
  assert.deepEqual([...anchors(text)], ["title"]);
  assert.deepEqual(links(text), ["b.md#c"]);
});

test("reports missing pages, missing anchors and links out of docs/", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-"));
  writeFileSync(join(root, "a.md"), "# A\n\n## Part one\n");
  writeFileSync(
    join(root, "b.md"),
    "[ok](a.md#part-one) [web](https://example.com) [self](#b) [gone](c.md) [bad](a.md#two) [out](../SECURITY.md)\n\n# B\n",
  );
  assert.deepEqual(check(root), [
    "b.md: c.md doesn't exist",
    "b.md: a.md#two has no heading for #two",
    "b.md: ../SECURITY.md is outside docs/, which GitHub Pages doesn't publish",
  ]);
});
