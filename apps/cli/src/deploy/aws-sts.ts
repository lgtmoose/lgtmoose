import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** The AWS account the current credentials belong to. */
export async function currentAccount(region: string): Promise<string> {
  const { Account } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  if (Account === undefined)
    throw new Error("AWS STS didn't say which account these credentials use.");
  return Account;
}
