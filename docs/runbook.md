# Runbook

## Add a collector
1. Create the Cognito user and add them to group `collector` (console, or `aws cognito-idp admin-create-user` + `admin-add-user-to-group`).
2. As an admin, `PUT /admin/collectors/<cognito sub>` with name, phone, areas (geohash5 cells), home lat/lng, rates.

## Make someone an admin
```bash
aws cognito-idp admin-add-user-to-group --user-pool-id <pool> --username <email> --group-name admin --region ap-south-1
```

## Requests stuck OPEN
- No active collector covers the cell: add the cell to a collector's `areas`.
- Group is under 15 kg and the window is more than an hour away: expected; it dispatches when the window nears.
- Force a sweep: `aws lambda invoke --function-name <DispatchFn> --payload '{}' --cli-binary-format raw-in-base64-out out.json`.

## Alarm: dispatcher errors / DLQ
Read the dispatcher log group `/aws/lambda/<DispatchFn>`. Fix, redeploy, then redrive the DLQ from the SQS console. Messages are only hints, so the schedule also recovers requests without them.

## Turn on SMS (after DLT registration)
`sam deploy ... --parameter-overrides SmsEnabled=true`, and keep the SNS SMS spend limit low.

## Roll back
CloudFormation rolls failed deploys back. To go back to a previous release redeploy the previous commit. The table has `DeletionPolicy: Retain` and point-in-time recovery.

## Collector login cards (v2)
- Admin tab "Collectors" > add a collector (name, phone, tap the areas on the map) > print the QR card. The code works once and for 7 days; "New card" replaces it.
- Lost phone: "Block". It signs the collector out everywhere and disables login until a new card is issued.
- From a terminal: `npm run card -- collector1@kabadi.example.com` prints a link for a seeded collector.

## Voice assistant
- Provider per call is in the Lambda log line `{"msg":"assistant","stt":...,"tts":...,"via":...}`; `via: rules` means Bedrock failed and keyword rules answered.
- Enable Bhashini: put `/kabadi/bhashini/userId` and `/kabadi/bhashini/apiKey` in SSM Parameter Store (SecureString). The Lambda caches them for 5 minutes. Delete them to go back to AWS only.
- Limits: 200 assistant turns and 20 photo estimates per user per day (table items `QUOTA#<sub>`, TTL 3 days).
