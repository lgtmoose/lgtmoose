export function validateSignup(input: { email: string; name: string }): string[] {
  const errors: string[] = [];
  const email = input.email.trim();
  if (email.length === 0 || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.push("email is not valid");
  }
  if (input.name.trim().length === 0) errors.push("name is required");
  return errors;
}
