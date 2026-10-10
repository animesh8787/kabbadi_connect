# Draft: Building Kabadi Connect on AWS (for AWS Builder Center)

Facts below are from the build; fill the bracketed parts with your own story before publishing.

**The problem.** [One paragraph, your city, a real kabadiwala if you interviewed one.]

**What we built.** Households post a pickup; requests are batched by area and time window; a kabadiwala gets an ordered route, records actual kg, the household confirms, and a dashboard shows kg kept out of landfill, CO2e avoided and route km saved.

**Stack.** React PWA on S3 + CloudFront; API Gateway with a Cognito authorizer; Lambda (Node 22, arm64) behind one DynamoDB table; SQS for event-driven dispatch with a DLQ; EventBridge schedule as a safety-net sweep; Amazon Location Service `OptimizeWaypoints` for route order with a local 2-opt fallback; SNS for ops events and an SMS path behind a flag; CloudWatch alarms and dashboard; SAM for everything.

**What fought back.**
- Concurrent dispatchers: solved with conditional writes inside a transaction instead of reserved concurrency (new accounts have a low concurrency quota).
- Idempotency: confirming a pickup twice must not double count impact, so the request update and the impact counters are one DynamoDB transaction guarded by `status = EN_ROUTE`.
- India SMS needs DLT registration, so SMS is a tested code path behind `SMS_ENABLED`, and the app itself is the primary channel.
- [Add what actually surprised you.]

**Impact numbers.** [Paste from the dashboard. State that CO2 factors are indicative unless you verified them.]

**What's next.** Pilot with one resident association; Amazon Location Maps instead of OpenStreetMap tiles; photo-based weight estimates with Bedrock.
