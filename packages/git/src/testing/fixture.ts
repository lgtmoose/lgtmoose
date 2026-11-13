import { mkdtemp, mkdir, rm, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runGit } from "../exec.js";

/**
 * A throwaway repository for tests: a working copy that pushes to a bare "remote", which the
 * code under test clones over file:// like it would from GitHub over HTTPS.
 */
export class FixtureRepo {
  private constructor(
    readonly root: string,
    readonly work: string,
    readonly remote: string,
  ) {}

  /** What a clone points at. */
  get url(): string {
    return pathToFileURL(this.remote).href;
  }

  static async create(): Promise<FixtureRepo> {
    const root = await mkdtemp(join(tmpdir(), "lgtmoose-git-"));
    const work = join(root, "work");
    const remote = join(root, "remote.git");
    await runGit(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
    // What GitHub allows: partial clones and fetching any reachable commit by SHA.
    for (const key of ["uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"]) {
      await runGit(remote, ["config", key, "true"]);
    }
    await runGit(root, ["init", "--quiet", "--initial-branch=main", work]);
    const fixture = new FixtureRepo(root, work, remote);
    const settings: [string, string][] = [
      ["user.name", "Fixture"],
      ["user.email", "fixture@example.com"],
      ["commit.gpgsign", "false"],
    ];
    for (const [key, value] of settings) await fixture.git(["config", key, value]);
    await fixture.git(["remote", "add", "origin", remote]);
    return fixture;
  }

  async git(args: readonly string[]): Promise<string> {
    return (await runGit(this.work, args)).stdout.trim();
  }

  async write(files: Record<string, string | Buffer>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(this.work, path)), { recursive: true });
      await writeFile(join(this.work, path), content);
    }
  }

  async remove(...paths: string[]): Promise<void> {
    for (const path of paths) await rm(join(this.work, path));
  }

  async move(from: string, to: string): Promise<void> {
    await mkdir(dirname(join(this.work, to)), { recursive: true });
    await rename(join(this.work, from), join(this.work, to));
  }

  /** Commits everything and force-pushes every branch, returning the new commit. */
  async commit(message: string): Promise<string> {
    await this.git(["add", "--all"]);
    await this.git(["commit", "--quiet", "--allow-empty", "-m", message]);
    await this.git(["push", "--quiet", "--force", "--all", "origin"]);
    return this.git(["rev-parse", "HEAD"]);
  }

  /**
   * Points `path` at a commit of another repository (a submodule) and commits it, without
   * needing the submodule itself.
   */
  async commitGitlink(path: string, commit: string, message: string): Promise<string> {
    await this.git(["update-index", "--add", "--cacheinfo", `160000,${commit},${path}`]);
    await this.git(["commit", "--quiet", "-m", message]);
    await this.git(["push", "--quiet", "--force", "--all", "origin"]);
    return this.git(["rev-parse", "HEAD"]);
  }

  async symlink(target: string, path: string): Promise<void> {
    await symlink(target, join(this.work, path));
  }

  async checkout(branch: string, create = false): Promise<void> {
    await this.git(
      create ? ["checkout", "--quiet", "-b", branch] : ["checkout", "--quiet", branch],
    );
  }

  /** Merges `branch` into the current branch with a merge commit, and pushes. */
  async merge(branch: string): Promise<string> {
    await this.git(["merge", "--quiet", "--no-ff", "--no-edit", branch]);
    await this.git(["push", "--quiet", "--force", "--all", "origin"]);
    return this.git(["rev-parse", "HEAD"]);
  }

  /** Rewrites the current branch onto `onto` and force-pushes, like a rebase before review. */
  async rebase(onto: string): Promise<string> {
    await this.git(["rebase", "--quiet", onto]);
    await this.git(["push", "--quiet", "--force", "--all", "origin"]);
    return this.git(["rev-parse", "HEAD"]);
  }

  /** Drops commits no branch points at from the remote, as GitHub eventually does. */
  async collectGarbage(): Promise<void> {
    await runGit(this.remote, ["reflog", "expire", "--expire=now", "--all"]);
    await runGit(this.remote, ["gc", "--quiet", "--prune=now"]);
  }

  /** A fresh, empty directory for a clone. */
  async cloneDir(): Promise<string> {
    return mkdtemp(join(this.root, "clone-"));
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
