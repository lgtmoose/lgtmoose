import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { TranscriptStore } from "@lgtmoose/harness";

/**
 * Saves run transcripts under a local directory, for a dry run on a laptop. Keys come from the
 * harness (`transcripts/<runId>/<n>.jsonl`); one that would land outside the directory is
 * refused.
 */
export class FileTranscriptStore implements TranscriptStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: string): Promise<void> {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(`${this.root}${sep}`)) {
      throw new Error(`Transcript key leaves the transcript directory: ${key}`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { mode: 0o600 });
  }
}
