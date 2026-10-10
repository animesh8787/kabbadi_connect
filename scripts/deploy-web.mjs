// Publish packages/web/dist to the stack's S3 bucket with runtime config, then invalidate CloudFront.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const stack = process.env.STACK ?? "kabadi-connect";
const region = process.env.AWS_REGION ?? "ap-south-1";
const aws = (...a) => execFileSync("aws", [...a, "--region", region], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const out = Object.fromEntries(
  JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json")).map((o) => [o.OutputKey, o.OutputValue]),
);
const dist = "packages/web/dist";
writeFileSync(`${dist}/config.json`, JSON.stringify({ apiUrl: out.ApiUrl, region, clientId: out.UserPoolClientId, collectorClientId: out.CollectorClientId, googleEnabled: out.GoogleEnabled === "true", authDomain: out.AuthDomain || "" }));

const bucket = `s3://${out.SiteBucketName}`;
aws("s3", "sync", dist, bucket, "--delete", "--cache-control", "public,max-age=31536000,immutable");
// Entry points must revalidate so deploys show up immediately.
for (const f of ["index.html", "sw.js", "config.json", "manifest.webmanifest", "registerSW.js"]) {
  try {
    aws("s3", "cp", `${dist}/${f}`, `${bucket}/${f}`, "--cache-control", "no-cache");
  } catch {
    /* file not produced by this build */
  }
}
aws("cloudfront", "create-invalidation", "--distribution-id", out.DistributionId, "--paths", "/*");
console.log(`Deployed: ${out.SiteUrl}`);
