import { isValidEmail } from "./email.js";

export function validateInvite(input: { email: string; role: "member" | "admin" }): string[] {
  const errors: string[] = [];
  if (!isValidEmail(input.email)) errors.push("email is not valid");
  if (input.role !== "member" && input.role !== "admin") errors.push("role is not valid");
  return errors;
}
