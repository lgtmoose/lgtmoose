// Run with `node --test tools/security/` (the security workflow does).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluate, parseAccepted } from "./audit.mjs";

const advisory = (id, module_name, severity) => ({
  id: 1,
  github_advisory_id: id,
  module_name,
  severity,
  title: `${module_name} problem`,
  patched_versions: ">=2.0.0",
});

const report = {
  advisories: {
    1: advisory("GHSA-5gmw-xhrv-c9v3", "tinypool", "critical"),
    2: advisory("GHSA-67mh-4wv8-2f99", "esbuild", "moderate"),
    3: advisory("GHSA-qxg6-89mg-rqv8", "lodash", "high"),
  },
};

const accept = (id, pkg, expires) => ({
  id,
  package: pkg,
  reason: "Only the test runner uses it, and it never runs PR code.",
  expires,
});

describe("evaluate", () => {
  it("fails on high and critical advisories that aren't accepted, and only reports the rest", () => {
    const result = evaluate(report, [], "2026-11-15");
    assert.deepEqual(
      result.failing.map((item) => item.package),
      ["tinypool", "lodash"],
    );
    assert.deepEqual(
      result.reported.map((item) => item.package),
      ["esbuild"],
    );
  });

  it("accepts a listed advisory through its expiry day", () => {
    const accepted = [accept("GHSA-5gmw-xhrv-c9v3", "tinypool", "2026-11-15")];
    const result = evaluate(report, accepted, "2026-11-15");
    assert.deepEqual(
      result.accepted.map((item) => item.package),
      ["tinypool"],
    );
    assert.deepEqual(
      result.failing.map((item) => item.package),
      ["lodash"],
    );
  });

  it("fails an expired acceptance, and doesn't accept its advisory", () => {
    const accepted = [accept("GHSA-5gmw-xhrv-c9v3", "tinypool", "2026-11-14")];
    const result = evaluate(report, accepted, "2026-11-15");
    assert.equal(result.expired.length, 1);
    assert.ok(result.failing.some((item) => item.package === "tinypool"));
  });

  it("accepts an advisory only for the package it names", () => {
    const accepted = [accept("GHSA-5gmw-xhrv-c9v3", "other", "2030-01-01")];
    assert.ok(
      evaluate(report, accepted, "2026-11-15").failing.some((i) => i.package === "tinypool"),
    );
  });
});

describe("parseAccepted", () => {
  it("reads the committed list", () => {
    const text = readFileSync(
      new URL("../../.github/security/accepted-advisories.json", import.meta.url),
      "utf8",
    );
    for (const entry of parseAccepted(text)) assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses entries without a GHSA ID, a reason or an expiry", () => {
    const bad = (entry) => JSON.stringify({ accepted: [entry] });
    assert.throws(() => parseAccepted(bad({ ...accept("CVE-2026-1", "x", "2030-01-01") })), /GHSA/);
    assert.throws(
      () =>
        parseAccepted(bad({ ...accept("GHSA-5gmw-xhrv-c9v3", "x", "2030-01-01"), reason: "ok" })),
      /reason/,
    );
    assert.throws(
      () => parseAccepted(bad({ ...accept("GHSA-5gmw-xhrv-c9v3", "x", "soon") })),
      /expires/,
    );
    assert.throws(() => parseAccepted("{}"), /accepted/);
  });
});
