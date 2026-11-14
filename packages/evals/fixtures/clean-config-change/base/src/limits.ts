import config from "../config/default.json" with { type: "json" };

/** Rejects an upload over the configured size before reading its body. */
export function checkSize(contentLength: number): void {
  if (contentLength > config.uploads.maxBytes) {
    throw Object.assign(new Error("upload too large"), { status: 413 });
  }
}
