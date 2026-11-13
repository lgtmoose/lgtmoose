import type { FileDiff } from "@lgtmoose/git";
import picomatch from "picomatch";

/** Why a file is left out of the review. "config" means a `skip` glob in `.lgtmoose.yaml`. */
export type SkipReason =
  | "binary"
  | "submodule"
  | "lockfile"
  | "minified"
  | "generated"
  | "build-output"
  | "vendored"
  | "config";

/** Default skip globs by reason. Each is matched against the whole path, at any depth. */
export const DEFAULT_SKIP: Readonly<
  Record<Exclude<SkipReason, "binary" | "submodule" | "config">, readonly string[]>
> = {
  lockfile: [
    "**/package-lock.json",
    "**/npm-shrinkwrap.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/bun.lock",
    "**/bun.lockb",
    "**/deno.lock",
    "**/Cargo.lock",
    "**/go.sum",
    "**/go.work.sum",
    "**/poetry.lock",
    "**/Pipfile.lock",
    "**/uv.lock",
    "**/pdm.lock",
    "**/composer.lock",
    "**/Gemfile.lock",
    "**/mix.lock",
    "**/pubspec.lock",
    "**/Podfile.lock",
    "**/Package.resolved",
    "**/packages.lock.json",
    "**/gradle.lockfile",
    "**/flake.lock",
    "**/.terraform.lock.hcl",
  ],
  minified: ["**/*.min.js", "**/*.min.mjs", "**/*.min.cjs", "**/*.min.css"],
  generated: [
    "**/*.generated.*",
    "**/*_generated.*",
    "**/__generated__/**",
    "**/*.pb.go",
    "**/*.pb.gw.go",
    "**/*_pb2.py",
    "**/*_pb2.pyi",
    "**/*_pb2_grpc.py",
    "**/*_pb.js",
    "**/*_pb.d.ts",
    "**/*_grpc_pb.js",
    "**/*.g.dart",
    "**/*.freezed.dart",
    "**/*.Designer.cs",
    "**/__snapshots__/**",
    "**/*.snap",
    "**/.pnp.cjs",
    "**/.pnp.loader.mjs",
  ],
  "build-output": [
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.svelte-kit/**",
    "**/.turbo/**",
    "**/cdk.out/**",
    "**/coverage/**",
    "**/__pycache__/**",
    "**/*.js.map",
    "**/*.mjs.map",
    "**/*.cjs.map",
    "**/*.css.map",
  ],
  vendored: [
    "**/vendor/**",
    "**/node_modules/**",
    "**/third_party/**",
    "**/third-party/**",
    "**/bower_components/**",
    "**/Pods/**",
    "**/.yarn/**",
  ],
};

/** Globs for test files. Tests always go last, whatever tier their globs match. */
export const TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.{go,py,rs,exs,dart,c,cc,cpp,erl}",
  "**/test_*.py",
  "**/*_spec.rb",
  "**/*Test.{java,kt,scala,groovy,php,cs,swift}",
  "**/*Tests.{java,kt,scala,cs,swift}",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/spec/**",
  "**/testdata/**",
  "**/fixtures/**",
  "**/e2e/**",
];

/** Header comments that mark a file as generated, such as Go's "Code generated ... DO NOT EDIT." */
const GENERATED_MARKERS = [
  /\bCode generated\b.*\bDO NOT EDIT\b/,
  /@generated\b/,
  /\bauto-?generated\b.*\bdo not (edit|modify)\b/i,
];

/** How far down a file a generated marker counts. Markers sit in the header. */
const MARKER_LINES = 5;

const MATCH_OPTIONS: picomatch.PicomatchOptions = { dot: true };

/** A matcher that names the first glob a path matches. */
export function globMatcher(globs: readonly string[]): (path: string) => string | undefined {
  const tests = globs.map((glob) => ({ glob, test: picomatch(glob, MATCH_OPTIONS) }));
  return (path) => tests.find(({ test }) => test(path))?.glob;
}

/** Whether the head side of the diff shows a generated marker in the file's first lines. */
export function hasGeneratedMarker(file: FileDiff): boolean {
  return file.hunks.some((hunk) =>
    hunk.lines.some(
      (line) =>
        line.kind !== "del" &&
        line.newLine !== undefined &&
        line.newLine <= MARKER_LINES &&
        GENERATED_MARKERS.some((marker) => marker.test(line.text)),
    ),
  );
}

export interface Skip {
  reason: SkipReason;
  /** The glob that matched, for glob-based reasons. */
  glob?: string;
}

/** Builds the skip check for a repo's `skip` globs on top of the defaults. */
export function skipClassifier(
  configSkip: readonly string[],
): (file: FileDiff) => Skip | undefined {
  const defaults = Object.entries(DEFAULT_SKIP).map(([reason, globs]) => ({
    reason: reason as SkipReason,
    match: globMatcher(globs),
  }));
  const configured = { reason: "config" as const, match: globMatcher(configSkip) };
  const byGlob = [...defaults, configured];
  return (file) => {
    if (file.binary) return { reason: "binary" };
    if (file.submodule) return { reason: "submodule" };
    for (const { reason, match } of byGlob) {
      const glob = match(file.path);
      if (glob !== undefined) return { reason, glob };
    }
    if (hasGeneratedMarker(file)) return { reason: "generated" };
    return undefined;
  };
}
