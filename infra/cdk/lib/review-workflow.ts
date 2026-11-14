import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type { ISecurityGroup, SubnetSelection } from "aws-cdk-lib/aws-ec2";
import type { ContainerDefinition, ICluster, TaskDefinition } from "aws-cdk-lib/aws-ecs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, type RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
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
  Pass,
  StateMachine,
  Succeed,
  Timeout,
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

/** The S3 prefix of a run's objects (`RUN_PREFIX` in @lgtmoose/pipeline). */
const RUN_PREFIX = "runs/";

/** How long the prepare step (clone, plan, upload) and the post step may take. */
export const CONTROL_STEP_TIMEOUT = Duration.minutes(30);
/** The model's own limit on one batch, which the control task passes to the sandbox. */
export const BATCH_TIMEOUT = Duration.minutes(20);
/** Image pull, checkout download and extraction on top of the model's limit. */
const SANDBOX_OVERHEAD = Duration.minutes(10);
/** How often a failed sandbox task is started again. */
const SANDBOX_ATTEMPTS = 3;

/** RunTask failing to start a task: no capacity, throttling. Safe to retry for any step. */
const ECS_START_ERRORS = ["ECS.AmazonECSException", "ECS.ServerException"];

export interface ReviewWorkflowProps {
  cluster: ICluster;
  retention: RetentionDays;
  artifactBucket: IBucket;
  control: { taskDefinition: TaskDefinition; container: ContainerDefinition };
  controlSubnets: SubnetSelection;
  controlSecurityGroup: ISecurityGroup;
  /** The reviewer provider's sandbox task. */
  sandbox: { taskDefinition: TaskDefinition; container: ContainerDefinition };
  sandboxSubnets: SubnetSelection;
  sandboxSecurityGroup: ISecurityGroup;
  /** Sandbox tasks run at once per review, from the deploy config. */
  maxConcurrency: number;
}

/**
 * The review workflow, one execution per review job (the execution input is the `ReviewJob`):
 *
 * 1. Prepare (control task, waits for its task token): records the run, clones and plans the
 *    PR, uploads the checkout and each batch's input, and returns the batches.
 * 2. Superseded? A newer push has its own execution: stop here.
 * 3. Batches (map, `maxConcurrency` at once): presign the batch's URLs, then run the reviewer's
 *    sandbox task on it. A batch that still fails after its retries is left without an output,
 *    which the post step counts as a failed batch: the review is incomplete and can't approve.
 * 4. Post (control task): reads the outputs and posts one review, the check run, the summary
 *    and the status label (or records them in shadow mode).
 *
 * Any step failing for good runs the control task's fail step, which marks the run failed and
 * posts nothing, and the execution fails.
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
        // Covers every attempt of the batch. URLs signed with the function's temporary
        // credentials stop working earlier if those expire first.
        LGTMOOSE_URL_TTL_SECONDS: String(
          BATCH_TIMEOUT.plus(SANDBOX_OVERHEAD).toSeconds() * SANDBOX_ATTEMPTS + 15 * 60,
        ),
      },
      logGroup: new LogGroup(this, "PresignLogs", {
        retention: props.retention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // Only run objects: the function presigns on its own credentials, so this is all a URL can
    // ever reach. No List either: a batch's URLs name its objects.
    presignFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [props.artifactBucket.arnForObjects(`${RUN_PREFIX}*`)],
      }),
    );

    const presign = new LambdaInvoke(this, "Presign", {
      lambdaFunction: presignFunction,
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

    const sandbox = new EcsRunTask(this, "Review", {
      cluster: props.cluster,
      taskDefinition: props.sandbox.taskDefinition,
      launchTarget: new EcsFargateLaunchTarget(),
      subnets: props.sandboxSubnets,
      securityGroups: [props.sandboxSecurityGroup],
      // Sandbox subnets have no route out but the proxy; never give a task a public address.
      assignPublicIp: false,
      integrationPattern: IntegrationPattern.RUN_JOB,
      containerOverrides: [
        {
          containerDefinition: props.sandbox.container,
          environment: [
            { name: "LGTMOOSE_BATCH_URLS", value: JsonPath.stringAt("$.presigned.urls") },
          ],
        },
      ],
      resultPath: JsonPath.DISCARD,
      taskTimeout: Timeout.duration(BATCH_TIMEOUT.plus(SANDBOX_OVERHEAD)),
    });
    // A model failure is written as the batch's output and the task succeeds; a failed task is
    // infrastructure (an expired URL, the image, capacity), worth another go.
    sandbox.addRetry({
      errors: [Errors.ALL],
      maxAttempts: SANDBOX_ATTEMPTS - 1,
      interval: Duration.seconds(30),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
    });

    const batchFailed = new Pass(this, "BatchFailed", {
      comment: "No output: the post step counts the batch as failed.",
    });
    const batch = presign.next(sandbox);
    presign.addCatch(batchFailed, { errors: [Errors.ALL], resultPath: "$.error" });
    sandbox.addCatch(batchFailed, { errors: [Errors.ALL], resultPath: "$.error" });

    const batches = new MapState(this, "Batches", {
      itemsPath: "$.prepared.batches",
      maxConcurrency: props.maxConcurrency,
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
      ],
      IntegrationPattern.RUN_JOB,
      JsonPath.DISCARD,
    );
    // Posting twice would post two reviews: only retry when the task never started.
    post.addRetry({
      errors: ECS_START_ERRORS,
      maxAttempts: 3,
      interval: Duration.seconds(30),
      backoffRate: 2,
      jitterStrategy: JitterType.FULL,
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

    const definition = prepare.next(
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
      timeout: Duration.hours(4),
      tracingEnabled: false,
      logs: {
        destination: logs,
        level: LogLevel.ERROR,
        // Inputs and outputs hold task tokens and presigned URLs.
        includeExecutionData: false,
      },
    });
    // Prepare reports through its task token.
    this.stateMachine.grantTaskResponse(props.control.taskDefinition.taskRole);
  }
}
