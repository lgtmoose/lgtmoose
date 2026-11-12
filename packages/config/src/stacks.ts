/**
 * CloudFormation stack names and CDK context flags. The CDK app defines the stacks with these
 * names; `lgtmoose deploy` and `destroy` drive them, so both sides must agree.
 */
export const STACK_NAMES = {
  meta: "Lgtmoose-Meta",
  network: "Lgtmoose-Network",
  data: "Lgtmoose-Data",
  api: "Lgtmoose-Api",
} as const;

/** Stack outputs the CLI reads from `cdk deploy --outputs-file`. */
export const STACK_OUTPUTS = {
  api: { githubWebhookUrl: "GithubWebhookUrl" },
  data: {
    artifactBucketName: "ArtifactBucketName",
    databaseSecretArn: "DatabaseSecretArn",
    databaseIdentifier: "DatabaseIdentifier",
  },
} as const;

export const CDK_CONTEXT = {
  /**
   * Turns off the database's deletion protection. `lgtmoose destroy` deploys the Data stack
   * with this set, then deletes; CloudFormation still takes a final snapshot.
   */
  allowDatabaseDeletion: "lgtmoose:allowDatabaseDeletion",
  /** `lgtmoose destroy --purge`: no final snapshot, and the bucket and its objects go too. */
  purge: "lgtmoose:purge",
} as const;
