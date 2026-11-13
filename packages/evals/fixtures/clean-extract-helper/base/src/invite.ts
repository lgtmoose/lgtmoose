export function validateInvite(input: { email: string; role: "member" | "admin" }): string[] {
  const errors: string[] = [];
  const email = input.email.trim();
  if (email.length === 0 || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.push("email is not valid");
  }
  if (input.role !== "member" && input.role !== "admin") errors.push("role is not valid");
  return errors;
}
