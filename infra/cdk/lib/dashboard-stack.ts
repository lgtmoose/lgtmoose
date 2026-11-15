import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  DockerImage,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { ISecurityGroup, IVpc, SubnetSelection } from "aws-cdk-lib/aws-ec2";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, type RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { DASHBOARD_CSP, FEEDBACK_REPORT_KEY, SECRET_NAMES, STACK_OUTPUTS } from "@lgtmoose/config";
import { lgtmooseFunction } from "./lambda.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DASHBOARD_HANDLER = join(REPO_ROOT, "apps/control/src/dashboard-lambda.ts");
const SITE_BUILD = join(REPO_ROOT, "apps/dashboard/scripts/build.mjs");

/** Where the dashboard API reads the dashboard's own origin (written once CloudFront exists). */
export const ORIGIN_PARAMETER_NAME = "/lgtmoose/dashboard/origin";

/**
 * Served on every dashboard response, the page and the API (see `DASHBOARD_CSP` in
 * @lgtmoose/config, which the compose dashboard server sends too).
 */
export { DASHBOARD_CSP };

export interface DashboardStackProps extends StackProps {
  vpc: IVpc;
  /** Subnets with a route to GitHub (through NAT) and to the database. */
  apiSubnets: SubnetSelection;
  /** The control security group: it may reach the database. */
  apiSecurityGroup: ISecurityGroup;
  databaseSecret: ISecret;
  databaseName: string;
  /** Holds the feedback report; the API may read that one key and nothing else. */
  artifactBucket: IBucket;
  allowedOrgs: readonly string[];
  logRetention: RetentionDays;
}

/**
 * The dashboard (NIC-840): a static site in a private S3 bucket behind CloudFront, and its own
 * HTTP API and Lambda, served by the same distribution at `/api/*`. One origin for the browser,
 * so there's no CORS and the session cookie is first-party.
 *
 * The API Lambda is separate from the internet-facing gateway and holds only what it needs: the
 * database, the App's OAuth client (`SECRET_NAMES.githubAppOAuth`, never the App's private key)
 * and a signing key this stack generates.
 */
export class DashboardStack extends Stack {
  readonly apiFunction: NodejsFunction;
  readonly distribution: Distribution;
  readonly siteBucket: Bucket;

  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);
    if (props.allowedOrgs.length === 0) throw new Error("DashboardStack needs an allowed org");

    const oauthSecret = Secret.fromSecretNameV2(
      this,
      "GithubAppOAuthSecret",
      SECRET_NAMES.githubAppOAuth,
    );
    const signingKey = new Secret(this, "SigningKey", {
      description: "Signs the LGTMoose dashboard's sign-in cookie. Generated; never leaves AWS.",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.apiFunction = lgtmooseFunction(this, "DashboardApiFunction", {
      entry: DASHBOARD_HANDLER,
      description: "The LGTMoose dashboard's API: sign-in, findings and review runs.",
      memorySize: 256,
      timeout: Duration.seconds(20),
      vpc: props.vpc,
      vpcSubnets: props.apiSubnets,
      securityGroups: [props.apiSecurityGroup],
      environment: {
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_NAME: props.databaseName,
        OAUTH_SECRET_ID: SECRET_NAMES.githubAppOAuth,
        SIGNING_KEY_SECRET_ARN: signingKey.secretArn,
        ORIGIN_PARAMETER_NAME,
        ALLOWED_ORGS: props.allowedOrgs.join(","),
        ARTIFACT_BUCKET: props.artifactBucket.bucketName,
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
      },
      bundling: { externalModules: ["pg-native"] },
      logGroup: new LogGroup(this, "DashboardApiLogs", {
        retention: props.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    props.databaseSecret.grantRead(this.apiFunction);
    oauthSecret.grantRead(this.apiFunction);
    signingKey.grantRead(this.apiFunction);
    // The acceptance report only: not transcripts, run data or anything else in the bucket.
    props.artifactBucket.grantRead(this.apiFunction, FEEDBACK_REPORT_KEY);
    // By ARN, not by the parameter resource: the parameter needs CloudFront, which needs the API.
    this.apiFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: ORIGIN_PARAMETER_NAME.slice(1),
          }),
        ],
      }),
    );

    // No CORS: the browser reaches this API only through the dashboard's own origin.
    const api = new HttpApi(this, "DashboardApi", {
      description: "LGTMoose dashboard API, served by the dashboard's CloudFront distribution",
      createDefaultStage: false,
    });
    new HttpStage(this, "DashboardApiStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    api.addRoutes({
      path: "/api/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: new HttpLambdaIntegration("DashboardApiIntegration", this.apiFunction),
    });

    this.siteBucket = new Bucket(this, "SiteBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Built from the repository on every deploy: nothing in it to keep.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new ResponseHeadersPolicy(this, "DashboardHeaders", {
      comment: "LGTMoose dashboard security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: DASHBOARD_CSP, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
    });

    this.distribution = new Distribution(this, "Distribution", {
      comment: "LGTMoose dashboard",
      defaultRootObject: "index.html",
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`, {
            protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          // Cookies, the query and headers such as Origin reach the API; Host is the API's own.
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });

    new BucketDeployment(this, "SiteDeployment", {
      sources: [
        Source.asset(join(REPO_ROOT, "apps/dashboard"), {
          bundling: {
            // Never used: the site builds locally with the workspace's esbuild.
            image: DockerImage.fromRegistry("node:24-slim"),
            local: {
              tryBundle(outputDir: string) {
                execFileSync(process.execPath, [SITE_BUILD, outputDir], { stdio: "inherit" });
                return true;
              },
            },
          },
        }),
      ],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });

    const origin = `https://${this.distribution.distributionDomainName}`;
    new StringParameter(this, "OriginParameter", {
      parameterName: ORIGIN_PARAMETER_NAME,
      stringValue: origin,
      description: "The LGTMoose dashboard's origin, for its API's sign-in and request checks.",
    });

    new CfnOutput(this, STACK_OUTPUTS.dashboard.dashboardUrl, {
      value: origin,
      description: "Open the dashboard here.",
    });
    new CfnOutput(this, STACK_OUTPUTS.dashboard.oauthCallbackUrl, {
      value: `${origin}/api/auth/callback`,
      description: "Add this as a callback URL in the GitHub App's settings.",
    });
  }
}
