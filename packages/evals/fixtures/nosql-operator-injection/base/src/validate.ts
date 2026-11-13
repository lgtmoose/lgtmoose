/** The value as a string, or a 400 error when it's anything else (an object, an array). */
export function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${name} must be a string`), { status: 400 });
  }
  return value;
}
