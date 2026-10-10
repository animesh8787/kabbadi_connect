# Architecture

## Data model (one DynamoDB table, on-demand, PITR, TTL)

| PK | SK | Notes |
|---|---|---|
| `REQ#<id>` | `META` | pickup request. `GSI1PK=OPEN` while unassigned (removed on assign/cancel), `GSI3PK=USER#<sub>` for "my pickups" |
| `BATCH#<id>` | `META` | ordered stop ids, route km vs naive km, routing source. `GSI2PK=COL#<sub>` |
| `COL#<sub>` | `META` | collector profile: areas (geohash5), home lat/lng, rates |
| `AREA#<geohash5>` | `COL#<sub>` | which collectors serve a cell (queried by the dispatcher) |
| `IMPACT#ALL` / `IMPACT#<geohash5>` | `<yyyy-mm-dd>` | daily counters updated with atomic `ADD` in the same transaction as the pickup confirmation |

## Security model

- API Gateway Cognito authorizer; groups `household`, `collector`, `admin` are enforced again inside every Lambda (`route()` in `packages/api/src/lib/http.ts`).
- Self sign-up lands in `household` (post-confirmation trigger). Collectors and admins are created by an admin.
- Households only see their own requests; collectors only see stops in batches assigned to them (a request of another collector returns 404, not 403).
- Inputs validated with zod at the boundary. Logs never include addresses or phone numbers.
- Table, queue and topic are encrypted. The site bucket is private behind CloudFront OAC.

## Failure handling

- Dispatcher is idempotent: requests move `OPEN -> ASSIGNED` under a condition inside a transaction with the batch; losers skip and the next sweep re-plans.
- SQS gives immediate dispatch; the 5-minute schedule recovers lost messages and picks up windows that are about to start. DLQ + alarm after 5 failed receives.
- Routing falls back to nearest-neighbour + 2-opt if Location Service errors; the batch records which path produced the route.
- Collector confirmations are queued in the browser while offline and retried when back online.
- Confirm / accept / start are idempotent.

## Alarms

Dispatcher errors, DLQ depth, API 5xx, monthly budget (when `AlertEmail` is set). Dashboard `kabadi-connect` in CloudWatch.

## v2 additions

- **Card login:** Cognito CUSTOM_AUTH (`customAuth.ts`). The card code's sha256 is stored on `COL#<sub>` (`enrollHash`, `enrollExp`); verify consumes it with a conditional update, so a code works once. A second app client (`CollectorClient`) has a 10-year refresh token. Revoke = remove the hash + global sign-out + disable the user.
- **Ledger:** confirming a pickup also writes `GSI2PK=COL#<sub>, GSI2SK=PICK#<13-digit ms>` on the request, so the monthly statement is one GSI2 range query. `BATCH#...` rows use the same index; queries bound their range so they never mix.
- **Voice:** `/assistant` = speech-to-text (Bhashini, else Transcribe) -> model tool call (Bedrock India profile, else keyword rules) -> `planReply()` builds the Hindi reply from real data -> text-to-speech (Bhashini, else Polly). The model never writes the sentence and never changes data; the phone performs the proposed action after a yes through the normal API.
- **Quota:** `QUOTA#<sub>` / `<kind>#<date>` counters with a conditional `ADD` cap voice and photo calls per user per day.
- **Impact counters:** daily `IMPACT#ALL` items also hold `segTotal`, `segGood`, `ackPickups`, `ackKg`.
