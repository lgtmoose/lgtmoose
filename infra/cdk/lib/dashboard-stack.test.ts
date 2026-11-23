import { Match, Template } from "aws-cdk-lib/assertions";
import {
  DASHBOARD_ORIGIN_HEADER,
  DASHBOARD_TOKEN_HEADER,
  FEEDBACK_REPORT_KEY,
  SECRET_NAMES,
  STACK_OUTPUTS,
  parseDeployConfig,
} from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DASHBOARD_CSP, ORIGIN_PARAMETER_NAME } from "./dashboard-stack.js";
import { appWithoutBundling } from "./test-utils.js";

function synth(dashboard?: boolean) {
  const config = parseDeployConfig({
    allowedOrgs: ["lgtmoose"],
    providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
    ...(dashboard === undefined ? {} : { dashboard }),
  });
  return buildApp(config, appWithoutBundling());
}

const built = synth();
if (built.dashboard === undefined) throw new Error("no dashboard stack");
const template = Template.fromStack(built.dashboard);

/** Every action and resource the dashboard API's role is granted, as JSON text. */
function apiRolePolicies(): string {
  const policies = template.findResources("AWS::IAM::Policy");
  return JSON.stringify(
    Object.values(policies).filter((policy) =>
      JSON.stringify(policy.Properties?.Roles ?? []).includes("DashboardApiFunction"),
    ),
  );
}

describe("DashboardStack", () => {
  it("is part of the app by default, and left out with dashboard: false", () => {
    expect(built.dashboard).toBeDefined();
    expect(synth(false).dashboard).toBeUndefined();
  });

  it("keeps the site in a private, encrypted bucket that only CloudFront reads", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.anyValue(),
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  it("serves the page and the API from one HTTPS origin, never caching the API", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: "/api/*",
            ViewerProtocolPolicy: "https-only",
            // Managed CachingDisabled, and the stack's own origin request policy.
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            OriginRequestPolicyId: { Ref: Match.stringLikeRegexp("DashboardApiRequests") },
          }),
        ],
      }),
    });
  });

  it("sends the API the viewer's address and a secret only CloudFront has (NIC-1140)", () => {
    // Cookies, the query, the headers the API reads and CloudFront-Viewer-Address; never Host.
    template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: Match.objectLike({
        CookiesConfig: { CookieBehavior: "all" },
        QueryStringsConfig: { QueryStringBehavior: "all" },
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: Match.arrayWith([
            "Origin",
            "Sec-Fetch-Site",
            DASHBOARD_TOKEN_HEADER,
            "CloudFront-Viewer-Address",
          ]),
        },
      }),
    });
    const policy = JSON.stringify(template.findResources("AWS::CloudFront::OriginRequestPolicy"));
    expect(policy).not.toMatch(/"Host"/i);
    // The API origin carries the generated secret, as a Secrets Manager reference, not text.
    const distribution = JSON.stringify(template.findResources("AWS::CloudFront::Distribution"));
    expect(distribution).toContain(DASHBOARD_ORIGIN_HEADER);
    expect(distribution).toMatch(/resolve:secretsmanager:/);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({ PasswordLength: 48 }),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ ORIGIN_SECRET_ARN: Match.anyValue() }) },
    });
    expect(apiRolePolicies()).toMatch(/OriginSecret/);
  });

  it("sends strict security headers on every response", () => {
    expect(DASHBOARD_CSP).toContain("script-src 'self'");
    expect(DASHBOARD_CSP).toContain("frame-ancestors 'none'");
    expect(DASHBOARD_CSP).not.toContain("unsafe-inline");
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: DASHBOARD_CSP, Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ContentTypeOptions: { Override: true },
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 63_072_000 }),
        }),
      }),
    });
    const distribution = JSON.stringify(template.findResources("AWS::CloudFront::Distribution"));
    // Both behaviors use the policy.
    expect(distribution.match(/ResponseHeadersPolicyId/g)).toHaveLength(2);
  });

  it("has its own API with no CORS, only GET and POST under /api, throttled", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.absent(),
    });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map(
      (route) => route.Properties?.RouteKey as string,
    );
    expect(routes.sort()).toEqual(["GET /api/{proxy+}", "POST /api/{proxy+}"]);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
  });

  it("gives the API Lambda the database, the OAuth client and its signing key, never the App's key", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OAUTH_SECRET_ID: SECRET_NAMES.githubAppOAuth,
          ORIGIN_PARAMETER_NAME,
          ALLOWED_ORGS: "lgtmoose",
        }),
      },
      VpcConfig: Match.anyValue(),
    });
    const policies = apiRolePolicies();
    expect(policies).toContain(SECRET_NAMES.githubAppOAuth);
    expect(policies).toContain("ssm:GetParameter");
    // The App secret's name pattern (six random characters after the name) appears nowhere.
    expect(policies).not.toContain(`secret:${SECRET_NAMES.githubApp}-??????`);
    expect(policies).not.toContain(SECRET_NAMES.githubWebhook);
    expect(policies).not.toContain("lgtmoose/provider/");
    expect(policies).not.toContain('"sqs:');
    expect(policies).not.toContain('"Action":"secretsmanager:*"');
  });

  it("lets the API read the feedback report and nothing else in the artifact bucket", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ ARTIFACT_BUCKET: Match.anyValue() }) },
      VpcConfig: Match.anyValue(),
    });
    const policies = apiRolePolicies();
    expect(policies).toContain(`/${FEEDBACK_REPORT_KEY}`);
    expect(policies).toContain("s3:GetObject");
    // No wildcard over the bucket's objects, and no writes.
    expect(policies).not.toMatch(/\/\*"/);
    expect(policies).not.toContain("s3:PutObject");
    expect(policies).not.toContain("s3:DeleteObject");
  });

  it("publishes the dashboard's origin for its API, and the URLs operators need", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: ORIGIN_PARAMETER_NAME });
    template.hasOutput(STACK_OUTPUTS.dashboard.dashboardUrl, Match.anyValue());
    template.hasOutput(STACK_OUTPUTS.dashboard.oauthCallbackUrl, {
      Value: Match.objectLike({
        "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp("/api/auth/callback$")])],
      }),
    });
  });
});
