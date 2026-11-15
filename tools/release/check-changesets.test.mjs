// Run with `node --test tools/release/check-changesets.test.mjs` (the release workflow does).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpedPackages, check, isChangeset } from "./check-changesets.mjs";

const files = (map) => (path) => {
  if (!(path in map)) throw new Error(`no file ${path}`);
  return map[path];
};

describe("isChangeset", () => {
  it("takes markdown files in .changeset, apart from its README", () => {
    assert.equal(isChangeset(".changeset/brave-owls-sing.md"), true);
    assert.equal(isChangeset(".changeset/README.md"), false);
    assert.equal(isChangeset(".changeset/config.json"), false);
    assert.equal(isChangeset("docs/releasing.md"), false);
  });
});

describe("bumpedPackages", () => {
  it("reads the packages a changeset bumps", () => {
    assert.deepEqual(bumpedPackages('---\n"lgtmoose": minor\n---\n\nAdds a thing.\n'), [
      "lgtmoose",
    ]);
    assert.deepEqual(bumpedPackages("---\nlgtmoose: patch\n'@lgtmoose/core': major\n---\n"), [
      "lgtmoose",
      "@lgtmoose/core",
    ]);
  });

  it("reads an empty changeset as bumping nothing", () => {
    assert.deepEqual(bumpedPackages("---\n---\n"), []);
  });

  it("refuses a file without front matter, or with an odd line", () => {
    assert.throws(() => bumpedPackages("Adds a thing.\n"), /no front matter/);
    assert.throws(() => bumpedPackages("---\nlgtmoose: huge\n---\n"), /isn't/);
  });
});

describe("check", () => {
  it("passes a code change with a changeset for lgtmoose", () => {
    const problems = check(
      ["apps/cli/src/cli.ts", ".changeset/brave-owls-sing.md"],
      files({ ".changeset/brave-owls-sing.md": '---\n"lgtmoose": patch\n---\n\nFixes it.\n' }),
    );
    assert.deepEqual(problems, []);
  });

  it("passes a code change with an empty changeset", () => {
    const problems = check(
      ["packages/core/src/index.ts", ".changeset/quiet-cats.md"],
      files({ ".changeset/quiet-cats.md": "---\n---\n" }),
    );
    assert.deepEqual(problems, []);
  });

  it("fails a code change without a changeset", () => {
    const problems = check(["infra/cdk/lib/app.ts"], files({}));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /adds no changeset/);
  });

  it("passes a change outside the code without one", () => {
    assert.deepEqual(
      check(["docs/costs.md", ".github/workflows/ci.yml", "README.md"], files({})),
      [],
    );
  });

  it("fails a changeset that bumps another package", () => {
    const problems = check(
      ["packages/core/src/index.ts", ".changeset/odd.md"],
      files({ ".changeset/odd.md": '---\n"@lgtmoose/core": minor\n---\n\nChanges core.\n' }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /bumps @lgtmoose\/core/);
  });

  it("fails a changeset without front matter", () => {
    const problems = check(
      ["apps/cli/src/cli.ts", ".changeset/broken.md"],
      files({ ".changeset/broken.md": "Just text.\n" }),
    );
    assert.match(problems[0], /no front matter/);
  });
});
