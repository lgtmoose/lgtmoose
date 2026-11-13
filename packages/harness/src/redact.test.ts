import { describe, expect, it } from "vitest";

import { containsSecret, redact, valueContainsSecret } from "./redact.js";

const KEY = "sk-ant-api03-AbCdEf123456";

describe("containsSecret", () => {
  it.each([
    ["literal", `key is ${KEY}`],
    ["base64", `fixture: ${Buffer.from(KEY).toString("base64")}`],
    ["base64 inside a longer run", Buffer.from(`token=${KEY};`).toString("base64")],
    ["base64url", Buffer.from(KEY).toString("base64url")],
    ["hex", Buffer.from(KEY).toString("hex")],
    ["URL-encoded", encodeURIComponent(`k=${KEY}`)],
    ["reversed", Array.from(KEY).reverse().join("")],
    ["spaced out", KEY.split("").join(" ")],
    ["split over lines", `${KEY.slice(0, 10)}\n${KEY.slice(10)}`],
  ])("finds the secret %s", (_, text) => {
    expect(containsSecret(text, [KEY])).toBe(true);
  });

  it("ignores text without it and short values", () => {
    expect(containsSecret("a normal finding about sk-ant handling", [KEY])).toBe(false);
    expect(containsSecret("value 1", ["1"])).toBe(false);
  });
});

describe("redact", () => {
  it("replaces literal and encoded forms", () => {
    const b64 = Buffer.from(KEY).toString("base64");
    expect(redact(`${KEY} ${b64}`, [KEY])).toBe("*** ***");
  });
});

describe("valueContainsSecret", () => {
  it.each([
    ["split by a newline", { body: `${KEY.slice(0, 10)}\n${KEY.slice(10)}` }],
    ["split by a tab", { body: `${KEY.slice(0, 10)}\t${KEY.slice(10)}` }],
    ["spread over two fields", { findings: [{ title: KEY.slice(0, 10), body: KEY.slice(10) }] }],
    ["in an object key", { [KEY]: 1 }],
  ])("finds the secret %s", (_, value) => {
    expect(valueContainsSecret(value, [KEY])).toBe(true);
    // The JSON text alone misses the split ones: that's why values are checked.
  });

  it("ignores output without it", () => {
    expect(valueContainsSecret({ findings: [{ title: "ok", line: 3 }] }, [KEY])).toBe(false);
  });
});
