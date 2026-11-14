/**
 * Replaces every secret in the text with `***`, in its literal form and its common encodings
 * (base64, base64url, hex, URL-encoded). Short values are skipped, so a flag like "1" isn't.
 */
export function redact(text: string, secrets: readonly string[]): string {
  return usable(secrets)
    .flatMap(encodings)
    .reduce((out, form) => out.split(form).join("***"), text);
}

/**
 * Whether the text contains any of the secrets: literally, in a common encoding, reversed, or
 * split up by spaces, punctuation or line breaks. The model can be told to disguise a key it
 * has seen, so a literal match alone isn't enough.
 */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  const candidates = usable(secrets);
  if (candidates.length === 0) return false;
  const views = textViews(text);
  return candidates.some((secret) => {
    const forms = [...encodings(secret), reverse(secret)];
    const bare = alphanumeric(secret);
    return views.some(
      (view) =>
        forms.some((form) => view.includes(form)) ||
        (bare.length >= MIN_SECRET_LENGTH && alphanumeric(view).includes(bare)),
    );
  });
}

/**
 * Whether any string in a parsed value (an object from the model's JSON output, say) contains a
 * secret. Strings are checked as they are, not as JSON text, where a newline becomes `\n` and
 * would split the key. All strings are also checked joined together, so a key spread over two
 * fields is found too.
 */
export function valueContainsSecret(value: unknown, secrets: readonly string[]): boolean {
  const keys: string[] = [];
  const values: string[] = [];
  collect(value, keys, values);
  return (
    [...keys, ...values].some((text) => containsSecret(text, secrets)) ||
    containsSecret(values.join(""), secrets)
  );
}

function collect(value: unknown, keys: string[], values: string[]): void {
  if (typeof value === "string") values.push(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, keys, values);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      collect(item, keys, values);
    }
  }
}

/**
 * Redacts a text that arrives in chunks, so nothing unredacted is ever kept: `push` returns what
 * is safe to keep so far, holding back an end that could be the start of a secret (in any of
 * the forms `redact` replaces) until the next chunk shows whether it is one.
 */
export class StreamRedactor {
  private readonly secrets: readonly string[];
  /** The longest form of any secret, less one: the most a partial secret can be. */
  private readonly hold: number;
  private carry = "";

  constructor(secrets: readonly string[]) {
    this.secrets = usable(secrets);
    const longest = Math.max(0, ...this.secrets.flatMap(encodings).map((form) => form.length));
    this.hold = Math.max(0, longest - 1);
  }

  push(chunk: string): string {
    if (this.secrets.length === 0) return chunk;
    const text = redact(this.carry + chunk, this.secrets);
    const keep = Math.min(this.hold, text.length);
    this.carry = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  /** The held-back end, once the stream is over. */
  end(): string {
    const rest = redact(this.carry, this.secrets);
    this.carry = "";
    return rest;
  }
}

const MIN_SECRET_LENGTH = 8;

function usable(secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
}

function encodings(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [
    secret,
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    encodeURIComponent(secret),
  ].filter((form, i, all) => all.indexOf(form) === i);
}

/** The text itself, plus the decoded form of every base64 or hex run in it. */
function textViews(text: string): string[] {
  const views = [text];
  for (const run of text.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? []) {
    views.push(Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"));
  }
  for (const run of text.match(/(?:[0-9a-fA-F]{2}){6,}/g) ?? []) {
    views.push(Buffer.from(run, "hex").toString("latin1"));
  }
  try {
    views.push(decodeURIComponent(text));
  } catch {
    // Not valid URL encoding; the literal view still applies.
  }
  return views;
}

function alphanumeric(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, "");
}

function reverse(text: string): string {
  return Array.from(text).reverse().join("");
}

const JSON_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/** Decodes the JSON string escapes in text that isn't valid JSON as a whole. */
function unescapeJson(text: string): string {
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (match, hex?: string, ch?: string) => {
    if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
    return JSON_ESCAPES[ch ?? ""] ?? match;
  });
}

/**
 * Replaces transcript lines that still hold a credential after `redact` with a stub. redact only
 * finds the literal and whole-value encodings; a key the model split over lines or wrote with a
 * JSON escape inside it is only found in the parsed event.
 */
export function withheldLines(body: string, secrets: readonly string[]): string {
  const stub = JSON.stringify({
    type: "lgtmoose_withheld",
    reason: "contained a model credential",
  });
  return body
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      let leaks: boolean;
      try {
        leaks = valueContainsSecret(JSON.parse(line), secrets);
      } catch {
        // Not whole JSON (stderr, or a line cut off when the run was killed): decode its JSON
        // escapes, or a `\n` inside the key would still split it.
        leaks = containsSecret(line, secrets) || containsSecret(unescapeJson(line), secrets);
      }
      return leaks ? stub : line;
    })
    .join("\n");
}
