import { describe, expect, it } from "vitest";

import { containsSecret, redact } from "./redact.js";

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
