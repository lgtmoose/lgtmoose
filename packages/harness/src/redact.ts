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
