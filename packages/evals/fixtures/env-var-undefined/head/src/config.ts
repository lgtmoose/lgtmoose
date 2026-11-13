/** A required setting from the environment; startup fails without it. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),
  paymentsApiKey: requireEnv("PAYMENTS_API_KEY"),
  webhookSecret: requireEnv("PAYMENTS_WEBHOOK_SECRET"),
};
