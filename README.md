# Kabadi Connect

Pickup network for informal recyclers. Households post a "pickup ready" request; requests are batched by area and time window, routed with Amazon Location Service, and handed to the local kabadiwala, who confirms the real weights. The dashboard shows kg kept out of landfill, CO2e avoided, segregation quality and route km saved.

Built for WeMakeDevs x AWS Environmental Hacks (Track 03, Waste and Energy).

![Scan to try the judge demo](docs/qr-judges.png)

**Live (ap-south-1):** https://d7oz11dsxwlh1.cloudfront.net  ·  **Judges: try it without logging in:** https://d7oz11dsxwlh1.cloudfront.net/judges  ·  **Method:** https://d7oz11dsxwlh1.cloudfront.net/methodology

**Judge demo:** `/judges` creates a throwaway demo collector with three ready pickups and shows a QR card to scan (or open on the same device). Demo data is flagged, kept out of the dispatcher and out of the real impact totals, expires after 3 days, is capped at 100 starts a day, and demo users get 30 voice turns a day.

## Designed for a collector who reads little

- **No email, no password.** An admin prints a **QR card**; the collector scans it once and stays signed in (custom Cognito auth, single-use code, revocable).
- **Hindi voice assistant.** Hold the big mic button and say "agla ghar kahan hai", "paanch kilo kagaz", "ghar par koi nahi". Replies are spoken back. Nothing is saved until the collector says or taps "haan".
- Large icons, Hindi-first screens, spoken read-out of every stop, offline-safe confirmations.
- A **monthly statement** (kg, rupees, household-confirmed pickups, no addresses) for income proof and EPR traceability.
- E-waste stops show the six government-listed authorised Delhi recyclers.
- A route toggle shows the optimised order against the order requests came in, with the km saved.
- Households get a dashboard: next-pickup tracker, their impact and earnings, history with printable receipts, rates and a sorting guide. A landing page at `/` shows live public totals.
- Maps are Amazon Location Service (Esri vector tiles via MapLibre), falling back to OpenStreetMap if the key is missing.

## How it works

```
PWA (S3 + CloudFront) -> API Gateway (Cognito authorizer) -> Lambda -> DynamoDB (single table)
                                          |
        createRequest -> SQS -> dispatch Lambda <- EventBridge schedule (5 min)
                                          |-> Amazon Location Routes OptimizeWaypoints (fallback: nearest-neighbour + 2-opt)
                                          |-> SNS (ops events; SMS to collectors behind SMS_ENABLED)
Voice:  phone mic (16 kHz WAV) -> /assistant Lambda -> Bhashini ASR (if keys) | Amazon Transcribe
                                   -> Bedrock tool call (India profile) | keyword rules
                                   -> Hindi reply built from real data -> Bhashini TTS | Amazon Polly (Kajal)
Photo:  household photo (shrunk on the phone) -> /photo-estimate -> Bedrock vision -> suggested materials/weights (never stored)
```

Request lifecycle: `OPEN -> ASSIGNED -> EN_ROUTE -> PICKED | MISSED`, or `CANCELLED`. Every transition is a conditional DynamoDB write, so concurrent dispatchers, double taps and retries cannot double-assign or double-count.

Dispatch rule: group open requests by geohash5 cell + window; dispatch when the group has at least 15 kg estimated or its window starts within an hour; at most 20 stops per batch; give it to the least-loaded active collector covering that cell.

Trust model: only collector-measured weights count; households can confirm them (counted separately). See `/methodology`.

Pilot plan: [docs/pilot-plan.md](docs/pilot-plan.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/runbook.md](docs/runbook.md), [docs/research.md](docs/research.md) (sources + field survey), [docs/demo-script.md](docs/demo-script.md), [docs/blog-draft.md](docs/blog-draft.md).

## Develop

```bash
npm install
npm test               # 52 unit tests (batching, routing, handlers, card login, voice intents, ledger, stale-batch release)
npm run e2e            # 22 Playwright tests at phone size, incl. an accessibility check (uses installed Edge; CI installs chromium)
npm run typecheck
npm run build:api && npm run build:web
```

## Deploy

Needs AWS credentials (`aws login`), AWS SAM CLI and Node 22.

```bash
npm run build:api && npm run build:web
sam deploy --stack-name kabadi-connect --region ap-south-1 --resolve-s3 --capabilities CAPABILITY_IAM
node scripts/deploy-web.mjs      # uploads the PWA + runtime config.json, invalidates CloudFront
npm run seed                      # demo ward + logins in .seed-credentials.json (gitignored)
npm run smoke                     # ~60 checks, request -> dispatch -> route -> pickup -> impact, card login, voice, ledger
npm run card -- collector1@kabadi.example.com   # prints a one-time card login link for a seeded collector
npm run qr                        # writes docs/qr-site.png and docs/qr-judges.png (+ SVG)
```

## Needs a human (not blocking the build)

| # | Task | Until then |
|---|---|---|
| H-bedrock | **Bedrock access** (draft email in `docs/aws-verification-email.md`). The account is still "being verified" for Bedrock (usually under 2 hours; otherwise aws-verification@amazon.com). Also complete any first-use form the Bedrock console asks for. | Voice uses keyword rules for common phrases (wide Hindi/Hinglish coverage); photo fill uses Amazon Rekognition labels with default weights the household can edit. Both switch to the model automatically once access works. |
| H14 | **Bhashini keys** (register at bhashini.gov.in). Store: `aws ssm put-parameter --region ap-south-1 --name /kabadi/bhashini/userId --type SecureString --value <id>` and the same for `/kabadi/bhashini/apiKey`. | Voice uses Amazon Transcribe + Polly. The Bhashini request format follows its public pipeline API and is **untested until keys exist**; any failure falls back to AWS automatically. |
| H3/H4 | TRAI DLT registration; verify numbers in the SNS SMS sandbox | `SMS_ENABLED=false`; collectors use the app. Deploy with `--parameter-overrides SmsEnabled=true` after DLT. |
| H5 | SES production access for sign-up emails beyond Cognito's default 50/day | Cognito default sender |
| H6 | Spot-check the sourced CO2 factors (US EPA WARM v16) and Delhi scrap-rate medians in `packages/shared/src/factors.json`; glass and e-waste rates are still placeholders | `/methodology` shows the source and status of every number |
| H7 | GitHub repo + OIDC role, set repo variable `AWS_DEPLOY_ROLE_ARN` | CI check job runs; deploy job is skipped |
| H8 | Demo video, a real kabadiwala interview, field survey ([docs/research.md](docs/research.md)), Builder Center blog, hackathon submission | Drafts in `docs/` |
| H11 | Try the mic on a real Android phone in a noisy street | Browser pane cannot use a microphone, so the recording path (MediaRecorder -> 16 kHz WAV) is untested on real hardware |
| H13 | Confirm the e-waste recycler authorisations and the research citations | Both marked unverified |
| H9 | Custom domain; short link (bit.ly/tinyurl) for `/judges` | CloudFront default URL and QR codes in `docs/` |
| H15 | Optional Google sign-in: create a Google OAuth client, then deploy with `--parameter-overrides GoogleClientId=... GoogleClientSecret=...` (redirect URI: `<site>/auth/callback`) | The Google button is hidden; email sign-in works |
| - | Map tiles: OpenStreetMap is for light use; switch to Amazon Location Maps (needs an API key) for real traffic | Fine for a demo |
| - | Budget alarm: deploy with `--parameter-overrides AlertEmail=you@example.com` | **No budget alarm is active** |

## Known limits

- Passwords are still used by households and admins (Cognito email + password). Collectors use cards.
- Tokens are kept in localStorage.
- Demo collectors create real Cognito users (up to 100 a day); they are not auto-deleted yet, only their data expires.
- Voice and photo costs are capped per user per day (200 voice turns, 20 photos). Fixed phrases are cached on the phone, not on the server.
- The map API key is restricted to this site and to read-only map access; it is visible in the page config by design.
- Dispatch reads all OPEN requests from one index partition; shard it by cell beyond roughly 100k open requests.
- A batch nobody starts within 2 hours of its window opening is released and re-offered to a different collector (unit-tested; not yet observed live because it needs the 2 hours to pass). If no other collector covers the area the requests stay open.
- Lambda logs are kept 30 days.
- Browser tests (`npm run e2e`) run against a mocked API, so they cover the UI, not the deployed backend; `npm run smoke` covers the backend. The microphone path is not covered by either.
- A phone app (Capacitor wrapper), an IVR line for basic phones, a WhatsApp bot and more languages are the next steps, not built.
