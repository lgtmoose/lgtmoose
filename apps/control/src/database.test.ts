import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseTls } from "./database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function file(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "lgtmoose-ca-"));
  directories.push(directory);
  const path = join(directory, "ca.pem");
  writeFileSync(path, contents);
  return path;
}

describe("databaseTls", () => {
  it("verifies with Node's trust store when no CA file is set", () => {
    expect(databaseTls()).toEqual({ rejectUnauthorized: true });
    expect(databaseTls()).not.toHaveProperty("ca");
  });

  it("trusts only the certificates in the file", () => {
    const path = file("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    expect(databaseTls(path)).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    });
  });

  it("fails when the file is missing or has no certificate", () => {
    expect(() => databaseTls("/no/such/rds-ca.pem")).toThrow(/could not be read \(ENOENT\)/);
    const path = file("not a certificate");
    expect(() => databaseTls(path)).toThrow(/has no certificate/);
  });
});
