import { isValidEmail } from "./email.js";

export function validateSignup(input: { email: string; name: string }): string[] {
  const errors: string[] = [];
  if (!isValidEmail(input.email)) errors.push("email is not valid");
  if (input.name.trim().length === 0) errors.push("name is required");
  return errors;
}
