/** Whether an address looks like an email: one @, a dot in the domain, at most 254 characters. */
export function isValidEmail(value: string): boolean {
  const email = value.trim();
  return email.length > 0 && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
