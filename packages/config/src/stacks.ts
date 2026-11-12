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
   * Synthesizes the database without deletion protection. `lgtmoose destroy` turns protection
   * off through the RDS API and passes this so the template agrees; CloudFormation still takes a
   * final snapshot.
   */
  allowDatabaseDeletion: "lgtmoose:allowDatabaseDeletion",
  /**
   * `lgtmoose destroy --purge` deploys the Data stack with this: no final snapshot, and the
   * database secret, the bucket and its objects go too. RDS's CloudWatch logs expire on their own.
   */
  purge: "lgtmoose:purge",
} as const;
