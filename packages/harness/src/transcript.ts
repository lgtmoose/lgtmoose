import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Where run transcripts go. Keys look like `transcripts/<runId>/<attempt>.jsonl`. */
export interface TranscriptStore {
  put(key: string, body: string): Promise<void>;
}

export function transcriptKey(runId: string, attempt: number): string {
  return `transcripts/${runId}/${attempt}.jsonl`;
}

/** The part of S3Client this store uses, so tests can pass a fake. */
export interface S3Sender {
  send(command: PutObjectCommand): Promise<unknown>;
}

export interface S3TranscriptStoreOptions {
  bucket: string;
  /** Put before every key, e.g. `"reviews/"`. Empty by default. */
  prefix?: string;
  /** Defaults to a new S3Client with the default credential chain. */
  client?: S3Sender;
}

/** Saves transcripts to S3 with PutObject. */
export class S3TranscriptStore implements TranscriptStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Sender;

  constructor(options: S3TranscriptStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? "";
    this.client = options.client ?? new S3Client({});
  }

  async put(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}${key}`,
        Body: body,
        ContentType: "application/x-ndjson",
      }),
    );
  }
}

/** Keeps transcripts in memory. For tests and local dry runs. */
export class MemoryTranscriptStore implements TranscriptStore {
  readonly objects = new Map<string, string>();

  put(key: string, body: string): Promise<void> {
    this.objects.set(key, body);
    return Promise.resolve();
  }
}
