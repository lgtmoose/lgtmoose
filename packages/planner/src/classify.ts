import type { FileDiff } from "@lgtmoose/git";
import picomatch from "picomatch";

/** Why a file is left out of the review. "config" means a `skip` glob in `.lgtmoose.yaml`. */
export type SkipReason =
  "binary" | "lockfile" | "minified" | "generated" | "build-output" | "vendored" | "config";

/** Workspace folders whose children are packages, as in most monorepos. */
const PACKAGE_PARENTS = "{packages,apps,libs,services,modules,crates,plugins,tools}";

/** Globs for folders at the repo root, or at the root of a workspace package (scoped too). */
function atRootOrPackage(folders: readonly string[]): string[] {
  return folders.flatMap((folder) => [
    `${folder}/**`,
    `${PACKAGE_PARENTS}/*/${folder}/**`,
    `${PACKAGE_PARENTS}/@*/*/${folder}/**`,
  ]);
}

/** Default skip globs by reason. Each is matched against the whole path, at any depth. */
export const DEFAULT_SKIP: Readonly<
  Record<Exclude<SkipReason, "binary" | "config">, readonly string[]>
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
  // Folder names like build/, out/ and vendor/ are also ordinary source folders
  // (src/commands/build/), so these only match at the repo root or directly inside a
  // workspace package. Names nobody uses for source match at any depth.
  "build-output": [
    ...atRootOrPackage(["dist", "build", "out", "coverage"]),
    "**/.next/**",
    "**/.nuxt/**",
    "**/.svelte-kit/**",
    "**/.turbo/**",
    "**/cdk.out/**",
    "**/__pycache__/**",
    "**/*.js.map",
    "**/*.mjs.map",
    "**/*.cjs.map",
    "**/*.css.map",
  ],
  vendored: [
    ...atRootOrPackage(["vendor", "third_party", "third-party"]),
    "**/node_modules/**",
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

/** Whether a file header (its first lines) has a generated marker. */
export function headerHasMarker(header: string): boolean {
  return header
    .split("\n", MARKER_LINES)
    .some((line) => GENERATED_MARKERS.some((marker) => marker.test(line)));
}

/**
 * Whether the diff shows a generated marker in the file's first lines on one side: RIGHT is
 * the head (added and context lines), LEFT the base (deleted and context lines).
 */
export function hasGeneratedMarker(file: FileDiff, side: "LEFT" | "RIGHT" = "RIGHT"): boolean {
  return file.hunks.some((hunk) =>
    hunk.lines.some((line) => {
      const number = side === "RIGHT" ? line.newLine : line.oldLine;
      const onSide = side === "RIGHT" ? line.kind !== "del" : line.kind !== "add";
      return (
        onSide &&
        number !== undefined &&
        number <= MARKER_LINES &&
        GENERATED_MARKERS.some((marker) => marker.test(line.text))
      );
    }),
  );
}

/**
 * First lines of files, by blob ID (see `readHeaders`). With them, a generated file is found
 * however far down its edits are; without, only a header inside a hunk counts.
 */
export type FileHeaders = ReadonlyMap<string, string>;

function markedOn(
  file: FileDiff,
  side: "LEFT" | "RIGHT",
  headers: FileHeaders | undefined,
): boolean {
  const blob = side === "RIGHT" ? file.newBlob : file.oldBlob;
  const header = blob === undefined ? undefined : headers?.get(blob);
  return header === undefined ? hasGeneratedMarker(file, side) : headerHasMarker(header);
}

/**
 * Whether a file is generated by its header marker. The PR controls its own head, so a marker
 * only counts if the base already had it: a PR can't hide a hand-written file by adding
 * `// @generated`, and a file the PR adds is always reviewed by its marker alone (generated
 * files the PR adds are still skipped when their path is a generated one, like `*.pb.go`).
 */
export function isMarkedGenerated(file: FileDiff, headers?: FileHeaders): boolean {
  if (file.status === "added") return false;
  return markedOn(file, "LEFT", headers) && markedOn(file, "RIGHT", headers);
}

export interface Skip {
  reason: SkipReason;
  /** The glob that matched, for glob-based reasons. */
  glob?: string;
}

/**
 * Builds the skip check for a repo's `skip` and `include` globs on top of the defaults. Checks
 * run in this order: binary, the repo's `skip` globs, the repo's `include` globs (which turn off
 * every default skip, the generated-header check included), the default skip globs, then the
 * generated header. When a `skip` glob and a default both match a file that isn't included, the
 * default's reason is kept (so a lockfile still gets its notes); for an included file the
 * repo's own `skip` glob is the reason.
 *
 * `configSkip` and `include` must come from the base commit's `.lgtmoose.yaml`, not the PR's:
 * otherwise a PR could add `skip: ["**"]` and hide itself. A renamed file is skipped by glob
 * only if its old path is skipped too, so moving a file into `vendor/` doesn't hide its edits.
 */
export function skipClassifier(
  configSkip: readonly string[],
  {
    headers,
    include = [],
  }: { headers?: FileHeaders | undefined; include?: readonly string[] | undefined } = {},
): (file: FileDiff) => Skip | undefined {
  const defaults = Object.entries(DEFAULT_SKIP).map(([reason, globs]) => ({
    reason: reason as SkipReason,
    match: globMatcher(globs),
  }));
  const configured = globMatcher(configSkip);
  const isIncluded = includeMatcher(include);
  const defaultSkip = (path: string): Skip | undefined => {
    for (const { reason, match } of defaults) {
      const glob = match(path);
      if (glob !== undefined) return { reason, glob };
    }
    return undefined;
  };
  /** The path's skip by glob, or "include" when an include glob turns the defaults off. */
  const pathSkip = (path: string): Skip | "include" | undefined => {
    const own = configured(path);
    const included = isIncluded(path);
    if (own !== undefined) {
      const ownSkip: Skip = { reason: "config", glob: own };
      return included ? ownSkip : (defaultSkip(path) ?? ownSkip);
    }
    if (included) return "include";
    return defaultSkip(path);
  };
  return (file) => {
    if (file.binary) return { reason: "binary" };
    const skip = pathSkip(file.path);
    if (skip === "include") return undefined;
    const old = file.oldPath === undefined ? undefined : pathSkip(file.oldPath);
    const movedIn = file.oldPath !== undefined && (old === undefined || old === "include");
    if (skip !== undefined && !movedIn) return skip;
    if (isMarkedGenerated(file, headers)) return { reason: "generated" };
    return undefined;
  };
}

/** Whether a path matches the repo's `include` globs, which turn the default skips off. */
export function includeMatcher(include: readonly string[]): (path: string) => boolean {
  const match = globMatcher(include);
  return (path) => match(path) !== undefined;
}
