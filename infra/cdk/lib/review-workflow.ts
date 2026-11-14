import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArnFormat, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { ISecurityGroup, SubnetSelection } from "aws-cdk-lib/aws-ec2";
import type { ContainerDefinition, ICluster, TaskDefinition } from "aws-cdk-lib/aws-ecs";
import { Effect, Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { LogGroup, type RetentionDays } from "aws-cdk-lib/aws-logs";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import {
  Choice,
  Condition,
  DefinitionBody,
  Errors,
  Fail,
  IntegrationPattern,
  JitterType,
  JsonPath,
  LogLevel,
  Map as MapState,
  Parallel,
  Pass,
  StateMachine,
  Succeed,
  TaskInput,
  Timeout,
  Wait,
  WaitTime,
  type IChainable,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  EcsFargateLaunchTarget,
  EcsRunTask,
  LambdaInvoke,
  type TaskEnvironmentVariable,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { lgtmooseFunction } from "./lambda.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PRESIGN_HANDLER = join(REPO_ROOT, "apps/control/src/lambda.ts");
const BROKER_HANDLER = join(REPO_ROOT, "apps/control/src/credentials-lambda.ts");

/** Where the broker keeps credential leases (`LEASE_PREFIX` in @lgtmoose/control). */
const LEASE_PREFIX = "credentials/leases/";

/** Errors the broker throws on purpose (credentials.ts in @lgtmoose/control). */
export const CREDENTIAL_BUSY = "Lgtmoose.CredentialBusy";
const CREDENTIAL_UNAVAILABLE = "Lgtmoose.CredentialUnavailable";
/** A sandbox attempt that failed after taking its lease, once the lease is given back. */
const SANDBOX_FAILED = "Lgtmoose.SandboxFailed";

/**
 * How long a batch waits for a free credential slot, at most: asked again every 20 s at first,
 * then every 2 minutes, for about three hours. A batch that never gets one fails, and the
 * review is incomplete.
 */
export const LEASE_WAIT = { first: Duration.seconds(20), max: Duration.minutes(2), attempts: 99 };

/** The S3 prefix of a run's objects (`RUN_PREFIX` in @lgtmoose/pipeline). */
const RUN_PREFIX = "runs/";

/** How long the prepare step (clone, plan, upload) and the post step may take. */
export const CONTROL_STEP_TIMEOUT = Duration.minutes(30);
/**
 * Prepare and post wait for a task token, so a control task that died without reporting would
 * hold its step for the whole timeout. They send a heartbeat as soon as they start and then
 * every 30 s (`HEARTBEAT_INTERVAL_MS` in @lgtmoose/control); this long without one fails the
 * step. The clock starts when the task is scheduled, so it covers a cold Fargate start too
 * (pulling the image, starting the container).
 */
export const TASK_HEARTBEAT = Duration.minutes(5);
/** The model's own limit on one batch, which the control task passes to the sandbox. */
export const BATCH_TIMEOUT = Duration.minutes(20);
/** Image pull, checkout download and extraction on top of the model's limit. */
const SANDBOX_OVERHEAD = Duration.minutes(10);
/** How often a failed sandbox task is started again. */
const SANDBOX_ATTEMPTS = 3;

/** How long a batch's presigned URLs last: one attempt, with room to start the task. */
const URL_TTL = BATCH_TIMEOUT.plus(SANDBOX_OVERHEAD).plus(Duration.minutes(15));

/**
 * How long a credential lease lasts if it's never given back (its execution died): longer than
 * one sandbox attempt may run, with room to start it.
 */
export const LEASE_TTL = BATCH_TIMEOUT.plus(SANDBOX_OVERHEAD).plus(Duration.minutes(10));

/**
 * The presigner role's session: long enough for every URL signed with it. Role chaining (the
 * function assuming another role) allows at most one hour.
 */
const PRESIGNER_SESSION = Duration.hours(1);

/** How often, and from how far apart, a failed post step is retried. */
export const POST_RETRIES = 3;
export const POST_RETRY_INTERVAL = Duration.minutes(1);

/** The task-token error for a failed post step (`POST_FAILED` in @lgtmoose/control). */
const POST_FAILED = "Lgtmoose.PostFailed";

/** RunTask failing to start a task: no capacity, throttling. Safe to retry for any step. */
const ECS_START_ERRORS = ["ECS.AmazonECSException", "ECS.ServerException"];

export interface ReviewWorkflowProps {
  cluster: ICluster;
  retention: RetentionDays;
  artifactBucket: IBucket;
  control: { taskDefinition: TaskDefinition; container: ContainerDefinition };
  controlSubnets: SubnetSelection;
  controlSecurityGroup: ISecurityGroup;
  /**
   * The providers a batch is reviewed on, in order: the reviewer's, then its fallbacks
   * (`providerChain`). At least one.
   */
  providers: readonly ReviewProvider[];
  sandboxSubnets: SubnetSelection;
  sandboxSecurityGroup: ISecurityGroup;
  /**
   * Sandbox tasks run at once per review, from the deploy config; lower when the reviewer's
   * credential allows fewer (its `limit`).
   */
  maxConcurrency: number;
  /** How long the broker's audit log is kept. */
  auditRetention: RetentionDays;
}

/** One provider a batch can be reviewed on: its sandbox task, and its credential if stored. */
export interface ReviewProvider {
  providerId: string;
  sandbox: { taskDefinition: TaskDefinition; container: ContainerDefinition };
  /**
   * The provider's stored credential, which each attempt on it leases around its sandbox task.
   * None for a Bedrock provider: it signs with the task role and has nothing to lease.
   */
  credential?: {
    auth: string;
    /** Tasks that may hold it at once, across reviews (`credentialConcurrency`). */
    limit: number;
    secret: ISecret;
  };
}

/**
 * The review workflow, one execution per review job. The dispatcher starts it with the
 * `ReviewJob` and `debounceSeconds` as input (`WorkflowInput` in @lgtmoose/control):
 *
 * 0. Debounce: wait `debounceSeconds` (a minute for a push, none for an opened PR). A newer push
 *    in that time stops the execution here, before anything is cloned.
 * 1. Prepare (control task, waits for its task token): records the run, clones and plans the
 *    PR, uploads the checkout and each batch's input, and returns the batches.
 * 2. Superseded? A newer push has its own execution: stop here.
 * 3. Batches (map, `maxConcurrency` at once): presign the batch's URLs, then run the reviewer's
 *    sandbox task on it. A batch that still fails after its retries is left without an output,
 *    which the post step counts as a failed batch: the review is incomplete and can't approve.
 * 4. Post (control task, waits for its task token, so a stop can't cut it short): reads the
 *    outputs and posts one review, the check run, the summary and the status label (or
 *    records them in shadow mode).
 *
 * Any step failing for good runs the control task's fail step, which marks the run failed and
 * posts nothing more, and the execution fails. An execution stopped from outside (StopExecution)
 * skips it: the dispatcher marks the run superseded before it stops one, and a prepare or post
 * task still running then marks the run when its task token turns out dead.
 *
 * Extension points (M4): the cross-file and verify passes go between the batches and post, as
 * steps in `afterBatches`; each reads and writes the run's objects like the batches do.
 */
export class ReviewWorkflow extends Construct {
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: ReviewWorkflowProps) {
    super(scope, id);

    const runControl = (
      name: string,
      environment: TaskEnvironmentVariable[],
      pattern: IntegrationPattern,
      resultPath: string,
    ) =>
      new EcsRunTask(this, name, {
        cluster: props.cluster,
        taskDefinition: props.control.taskDefinition,
        launchTarget: new EcsFargateLaunchTarget(),
        subnets: props.controlSubnets,
        securityGroups: [props.controlSecurityGroup],
        assignPublicIp: false,
        integrationPattern: pattern,
        containerOverrides: [
          {
            containerDefinition: props.control.container,
            environment: [
              { name: "LGTMOOSE_EXECUTION_ARN", value: JsonPath.stringAt("$$.Execution.Id") },
              ...environment,
            ],
          },
        ],
        resultPath,
        taskTimeout: Timeout.duration(CONTROL_STEP_TIMEOUT),
        ...(pattern === IntegrationPattern.WAIT_FOR_TASK_TOKEN
          ? { heartbeatTimeout: Timeout.duration(TASK_HEARTBEAT) }
          : {}),
      });

    const prepare = runControl(
      "Prepare",
      [
        { name: "LGTMOOSE_COMMAND", value: "prepare" },
        {
          name: "LGTMOOSE_JOB",
          value: JsonPath.jsonToString(JsonPath.objectAt("$$.Execution.Input")),
        },
        { name: "LGTMOOSE_TASK_TOKEN", value: JsonPath.taskToken },
      ],
      IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      "$.prepared",
    );
    // Prepare is safe to run again: it finds the run its first attempt recorded.
    prepare.addRetry({
      errors: [Errors.ALL],
      maxAttempts: 2,
      interval: Duration.seconds(30),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
    });

    const presignFunction = lgtmooseFunction(this, "PresignFunction", {
      entry: PRESIGN_HANDLER,
      description: "Presigns one review batch's S3 URLs for its sandbox task.",
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        ARTIFACT_BUCKET: props.artifactBucket.bucketName,
        // One attempt of the batch, with room to start. Each attempt is presigned afresh.
        LGTMOOSE_URL_TTL_SECONDS: String(URL_TTL.toSeconds()),
      },
      logGroup: new LogGroup(this, "PresignLogs", {
        retention: props.retention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // URLs are signed with this role's credentials, assumed for a fixed hour on each
    // invocation: a URL signed with temporary credentials stops working when they expire, and
    // the function's own may be close to expiring. Only run objects, so this is all a URL can
    // ever reach; no List either, since a batch's URLs name its objects.
    const presigner = new Role(this, "PresignerRole", {
      assumedBy: presignFunction.role!,
      maxSessionDuration: PRESIGNER_SESSION,
      description: "Signs review batches' S3 URLs (assumed by the presign function).",
    });
    presigner.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [props.artifactBucket.arnForObjects(`${RUN_PREFIX}*`)],
      }),
    );
    presigner.grantAssumeRole(presignFunction.role!);
    presignFunction.addEnvironment("LGTMOOSE_PRESIGNER_ROLE_ARN", presigner.roleArn);
    presignFunction.addEnvironment(
      "LGTMOOSE_PRESIGNER_SESSION_SECONDS",
      String(PRESIGNER_SESSION.toSeconds()),
    );

    const [first] = props.providers;
    if (first === undefined) throw new Error("The review workflow needs at least one provider.");
    const batchFailed = new Pass(this, "BatchFailed", {
      comment: "No output: the post step counts the batch as failed.",
    });
    // Each provider in turn, from the reviewer's: an attempt, then (unless it's the last) a look
    // at the batch's output, and the next provider when this one hit a limit or an auth failure,
    // couldn't take the prompt, or left no usable output (`checkOutcome`). The last provider's
    // outcome stands: a batch that failed there is a failed batch, so the review is incomplete
    // and can't approve.
    // Built from the last provider back, so each attempt knows where its batch goes next.
    let onward: IChainable = batchFailed;
    const last = props.providers.length - 1;
    for (let i = last; i >= 0; i -= 1) {
      const provider = props.providers[i]!;
      // The reviewer's states keep their plain names; a fallback's carry its provider's id.
      const suffix = i === 0 ? "" : `-${provider.providerId}`;
      const attempt = this.attempt(props, presignFunction, provider, suffix);
      // An attempt that failed outright (its retries spent, no credential slot, an unusable
      // credential) goes on to the next provider, or fails the batch after the last.
      attempt.addCatch(onward, { errors: [Errors.ALL], resultPath: "$.error" });
      if (i < last) {
        const check = new LambdaInvoke(this, `CheckOutcome${suffix}`, {
          lambdaFunction: presignFunction,
          payload: TaskInput.fromObject({
            action: "outcome",
            runId: JsonPath.stringAt("$.runId"),
            index: JsonPath.numberAt("$.index"),
            providerId: provider.providerId,
          }),
          payloadResponseOnly: true,
          resultPath: "$.outcome",
          taskTimeout: Timeout.duration(Duration.minutes(1)),
        });
        check.addRetry({
          errors: [Errors.ALL],
          maxAttempts: 3,
          interval: Duration.seconds(5),
          backoffRate: 2,
          jitterStrategy: JitterType.FULL,
        });
        // The output can't be read: leave it as it is for the post step to judge.
        check.addCatch(new Succeed(this, `OutcomeUnknown${suffix}`), {
          errors: [Errors.ALL],
          resultPath: JsonPath.DISCARD,
        });
        const choice = new Choice(this, `FallBack${suffix}?`)
          .when(Condition.booleanEquals("$.outcome.fallback", true), onward)
          .otherwise(new Succeed(this, `BatchDone${suffix}`));
        attempt.next(check).next(choice);
      }
      onward = attempt;
    }
    const batch = onward;

    // Every batch starts on the reviewer's provider, so at most as many run at once as its
    // credential allows (`credentialConcurrency`); the broker's leases also cap it across
    // reviews, and a batch waiting for a slot waits in its lease step, not in a sandbox task.
    const concurrency = Math.min(props.maxConcurrency, first.credential?.limit ?? Infinity);
    const batches = new MapState(this, "Batches", {
      itemsPath: "$.prepared.batches",
      maxConcurrency: concurrency,
      itemSelector: {
        runId: JsonPath.stringAt("$.prepared.runId"),
        index: JsonPath.numberAt("$$.Map.Item.Value.index"),
      },
      resultPath: JsonPath.DISCARD,
    });
    batches.itemProcessor(batch);

    const post = runControl(
      "Post",
      [
        { name: "LGTMOOSE_COMMAND", value: "post" },
        { name: "LGTMOOSE_RUN_ID", value: JsonPath.stringAt("$.prepared.runId") },
        { name: "LGTMOOSE_TASK_TOKEN", value: JsonPath.taskToken },
      ],
      // Not `.sync`: stopping the execution (a newer push, the PR closed) would stop the task
      // halfway through posting. With a task token it finishes, and its review, for an older
      // head, is followed by the next run's.
      IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      JsonPath.DISCARD,
    );
    // The task never started: safe to retry at once.
    post.addRetry({
      errors: ECS_START_ERRORS,
      maxAttempts: 3,
      interval: Duration.seconds(30),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
    });
    // A GitHub write failed, or the task died: post records its progress in the run's
    // objects, and claims the review (naming its ECS task) before posting it, so a retry
    // carries on from there and never posts a second review. A retry that finds the claim held
    // by a task still running fails until that task has stopped; one that missed its heartbeat
    // stops at its next beat, or ECS stops it. No jitter, so the retries surely span more than
    // the heartbeat timeout: 1 + 2 + 4 = 7 minutes.
    post.addRetry({
      errors: [POST_FAILED, Errors.HEARTBEAT_TIMEOUT],
      maxAttempts: POST_RETRIES,
      interval: POST_RETRY_INTERVAL,
      backoffRate: 2,
      jitterStrategy: JitterType.NONE,
    });

    const failRun = runControl(
      "MarkFailed",
      [
        { name: "LGTMOOSE_COMMAND", value: "fail" },
        // The error name only: an ECS task's cause describes the task, presigned URLs included.
        { name: "LGTMOOSE_ERROR", value: JsonPath.stringAt("$.error.Error") },
      ],
      IntegrationPattern.RUN_JOB,
      JsonPath.DISCARD,
    );
    failRun.addRetry({
      errors: [Errors.ALL],
      maxAttempts: 3,
      interval: Duration.seconds(15),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
    });
    const failed = new Fail(this, "ReviewFailed", {
      error: "Lgtmoose.ReviewFailed",
      cause: "A step failed; the run is marked failed and nothing was posted.",
    });
    failRun.addCatch(failed, { errors: [Errors.ALL], resultPath: "$.failError" });
    const onFailure = failRun.next(failed);
    for (const step of [prepare, batches, post]) {
      step.addCatch(onFailure, { errors: [Errors.ALL], resultPath: "$.error" });
    }

    /** M4: cross-file and verify go here, between the batches and post. */
    const afterBatches: IChainable = post;

    const debounce = new Wait(this, "Debounce", {
      comment: "A newer push in the meantime stops this execution before it clones.",
      time: WaitTime.secondsPath("$.debounceSeconds"),
    });

    const definition = debounce
      .next(prepare)
      .next(
        new Choice(this, "Superseded?")
          .when(
            Condition.booleanEquals("$.prepared.superseded", true),
            new Succeed(this, "Superseded", { comment: "A newer push has its own review." }),
          )
          .otherwise(batches.next(afterBatches)),
      );

    const logs = new LogGroup(this, "Logs", {
      retention: props.retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(definition),
      // No execution timeout: one would stop the execution without running the fail step, and
      // leave the run "running". Every task has its own timeout, so an execution still ends.
      tracingEnabled: false,
      logs: {
        destination: logs,
        level: LogLevel.ERROR,
        // Inputs and outputs hold task tokens and presigned URLs.
        includeExecutionData: false,
      },
    });
    // Prepare and post report through their task tokens, and check whether their execution
    // was stopped when a token no longer counts.
    this.stateMachine.grantTaskResponse(props.control.taskDefinition.taskRole);
    this.stateMachine.grantExecution(
      props.control.taskDefinition.taskRole,
      "states:DescribeExecution",
    );
    if (this.brokerFunction !== undefined) {
      // A lease's holder is done when its execution no longer runs. A policy of its own, not
      // the function's default one: the state machine refers to the function, so the function
      // mustn't depend on a policy that refers to the state machine.
      new Policy(this, "BrokerExecutionPolicy", {
        roles: [this.brokerFunction.role!],
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["states:DescribeExecution"],
            resources: [
              Stack.of(this).formatArn({
                service: "states",
                resource: "execution",
                resourceName: `${this.stateMachine.stateMachineName}:*`,
                arnFormat: ArnFormat.COLON_RESOURCE_NAME,
              }),
            ],
          }),
        ],
      });
    }
  }

  /** The credential broker Lambda, when a provider of the chain has a stored credential. */
  brokerFunction: NodejsFunction | undefined;

  /**
   * One batch attempt on one provider: fresh URLs, then the provider's sandbox task. A model
   * failure is written as the batch's output and the task succeeds; a failed task is
   * infrastructure (the image, capacity), worth another go, and the retry presigns again so its
   * URLs are new too. With a stored credential, the attempt first leases it, and gives it back
   * after the task, whatever the task did (`leased`). `suffix` tells a fallback provider's
   * states from the reviewer's.
   */
  private attempt(
    props: ReviewWorkflowProps,
    presignFunction: NodejsFunction,
    provider: ReviewProvider,
    suffix: string,
  ): Parallel {
    const presign = new LambdaInvoke(this, `Presign${suffix}`, {
      lambdaFunction: presignFunction,
      payload: TaskInput.fromObject({
        runId: JsonPath.stringAt("$.runId"),
        index: JsonPath.numberAt("$.index"),
        // A ChatGPT sign-in's task also gets a URL to hand its refreshed auth.json back.
        ...(provider.credential?.auth === "chatgpt-login" ? { credentialRefresh: true } : {}),
      }),
      payloadResponseOnly: true,
      resultPath: "$.presigned",
      taskTimeout: Timeout.duration(Duration.minutes(1)),
    });
    presign.addRetry({
      errors: [Errors.ALL],
      maxAttempts: 3,
      interval: Duration.seconds(5),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
    });

    const sandbox = new EcsRunTask(this, `Review${suffix}`, {
      cluster: props.cluster,
      taskDefinition: provider.sandbox.taskDefinition,
      launchTarget: new EcsFargateLaunchTarget(),
      subnets: props.sandboxSubnets,
      securityGroups: [props.sandboxSecurityGroup],
      // Sandbox subnets have no route out but the proxy; never give a task a public address.
      assignPublicIp: false,
      integrationPattern: IntegrationPattern.RUN_JOB,
      containerOverrides: [
        {
          containerDefinition: provider.sandbox.container,
          environment: [
            { name: "LGTMOOSE_BATCH_URLS", value: JsonPath.stringAt("$.presigned.urls") },
          ],
        },
      ],
      resultPath: JsonPath.DISCARD,
      taskTimeout: Timeout.duration(BATCH_TIMEOUT.plus(SANDBOX_OVERHEAD)),
    });

    const attempt = new Parallel(this, `Attempt${suffix}`, { resultPath: JsonPath.DISCARD });
    attempt.branch(
      provider.credential === undefined
        ? presign.next(sandbox)
        : this.leased(this.broker(props), provider.providerId, suffix, presign, sandbox),
    );
    // Waiting for a credential slot has its own retries; a credential that can't be used won't
    // be fixed by another attempt.
    attempt.addRetry({ errors: [CREDENTIAL_BUSY, CREDENTIAL_UNAVAILABLE], maxAttempts: 0 });
    attempt.addRetry({
      errors: [Errors.ALL],
      maxAttempts: SANDBOX_ATTEMPTS - 1,
      interval: Duration.seconds(30),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
    });
    return attempt;
  }

  /**
   * The credential broker Lambda, made on first use, for every provider of the chain with a
   * stored credential: one lease table, and IAM for each of their secrets.
   */
  private broker(props: ReviewWorkflowProps): NodejsFunction {
    if (this.brokerFunction !== undefined) return this.brokerFunction;
    const stored = props.providers.flatMap((provider) =>
      provider.credential === undefined
        ? []
        : [{ ...provider.credential, id: provider.providerId }],
    );
    const fn = lgtmooseFunction(this, "BrokerFunction", {
      entry: BROKER_HANDLER,
      description: "Leases the reviewers' model credentials around each sandbox task.",
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        ARTIFACT_BUCKET: props.artifactBucket.bucketName,
        LGTMOOSE_LEASE_TTL_SECONDS: String(LEASE_TTL.toSeconds()),
        LGTMOOSE_CREDENTIALS: JSON.stringify(
          Object.fromEntries(
            stored.map((credential) => [
              credential.id,
              {
                secretId: credential.secret.secretArn,
                auth: credential.auth,
                limit: credential.limit,
              },
            ]),
          ),
        ),
      },
      // The audit log: which run and batch used which credential version.
      logGroup: new LogGroup(this, "BrokerLogs", {
        retention: props.auditRetention,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
    });
    this.brokerFunction = fn;
    const bucket = props.artifactBucket;
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [bucket.arnForObjects(`${LEASE_PREFIX}*`)],
      }),
    );
    // A batch's output, to tell an auth failure; and a sign-in's refreshed auth.json.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [
          bucket.arnForObjects(`${RUN_PREFIX}*/batches/*/output.json`),
          bucket.arnForObjects(`${RUN_PREFIX}*/batches/*/credential.json`),
        ],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:DeleteObject"],
        resources: [bucket.arnForObjects(`${RUN_PREFIX}*/batches/*/credential.json`)],
      }),
    );
    // Their state and version, never their values...
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:DescribeSecret", "secretsmanager:ListSecretVersionIds"],
        resources: stored.map((credential) => secretArnPattern(credential.secret)),
      }),
    );
    // ...except for a ChatGPT sign-in, whose refreshed auth.json it stores after checking it's
    // for the same account.
    const signIns = stored.filter((credential) => credential.auth === "chatgpt-login");
    if (signIns.length > 0) {
      fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
          resources: signIns.map((credential) => secretArnPattern(credential.secret)),
        }),
      );
    }
    return fn;
  }

  /**
   * One attempt that leases its provider's credential: take a lease (waiting while every slot is
   * in use), presign, run the sandbox task, and give the lease back. A failure after the lease
   * gives it back too, then fails the attempt for the attempt's own retries.
   */
  private leased(
    fn: NodejsFunction,
    providerId: string,
    suffix: string,
    presign: LambdaInvoke,
    sandbox: EcsRunTask,
  ): IChainable {
    const batchRef = {
      providerId,
      runId: JsonPath.stringAt("$.runId"),
      index: JsonPath.numberAt("$.index"),
    };
    const acquire = new LambdaInvoke(this, `Lease${suffix}`, {
      lambdaFunction: fn,
      payload: TaskInput.fromObject({
        action: "acquire",
        ...batchRef,
        executionArn: JsonPath.stringAt("$$.Execution.Id"),
      }),
      payloadResponseOnly: true,
      resultPath: "$.lease",
      taskTimeout: Timeout.duration(Duration.minutes(1)),
    });
    acquire.addRetry({
      errors: [CREDENTIAL_BUSY],
      interval: LEASE_WAIT.first,
      maxDelay: LEASE_WAIT.max,
      backoffRate: 1.5,
      maxAttempts: LEASE_WAIT.attempts,
      jitterStrategy: JitterType.FULL,
    });
    // Lambda's own transient errors are retried by LambdaInvoke's default retry.
    const release = (id: string) => {
      const step = new LambdaInvoke(this, id, {
        lambdaFunction: fn,
        payload: TaskInput.fromObject({
          action: "release",
          ...batchRef,
          lease: JsonPath.objectAt("$.lease"),
        }),
        payloadResponseOnly: true,
        resultPath: JsonPath.DISCARD,
        taskTimeout: Timeout.duration(Duration.minutes(1)),
      });
      step.addRetry({
        errors: [Errors.ALL],
        interval: Duration.seconds(5),
        maxAttempts: 4,
        backoffRate: 2,
        jitterStrategy: JitterType.FULL,
      });
      return step;
    };
    // A release that keeps failing doesn't fail the batch: its review is done, and the lease
    // expires (`LEASE_TTL`). A refreshed auth.json is then stored by whoever takes the slot.
    const done = new Pass(this, `Released${suffix}`);
    const releaseAfterTask = release(`Release${suffix}`);
    releaseAfterTask.addCatch(done, { errors: [Errors.ALL], resultPath: JsonPath.DISCARD });
    const attemptFailed = new Fail(this, `AttemptFailed${suffix}`, {
      error: SANDBOX_FAILED,
      cause: "The sandbox attempt failed; its credential lease was given back.",
    });
    const releaseAfterFailure = release(`ReleaseAfterFailure${suffix}`);
    releaseAfterFailure.addCatch(attemptFailed, {
      errors: [Errors.ALL],
      resultPath: JsonPath.DISCARD,
    });
    const failedAfterLease = releaseAfterFailure.next(attemptFailed);
    for (const step of [presign, sandbox]) {
      step.addCatch(failedAfterLease, { errors: [Errors.ALL], resultPath: "$.attemptError" });
    }
    return acquire.next(presign).next(sandbox).next(releaseAfterTask).next(done);
  }
}

/**
 * A secret's ARN for IAM. A secret referenced by name has no full ARN; this matches it with the
 * six random characters Secrets Manager adds.
 */
export function secretArnPattern(secret: ISecret): string {
  return secret.secretFullArn ?? `${secret.secretArn}-??????`;
}
