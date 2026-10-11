# Kabadi Connect: a Hindi, voice-first pickup network for India's scrap collectors, built on AWS

*Built for the WeMakeDevs × AWS Environmental Hacks (Waste and Energy track). Live demo: https://d7oz11dsxwlh1.cloudfront.net/judges · Code: https://github.com/animesh8787/kabbadi_connect*

## The problem

Walk down any Indian street and you will meet a kabadiwala: the scrap collector who buys newspapers, plastic and metal from households and keeps a large share of the country's recyclable waste out of landfill. Estimates of how many people work in this informal recycling sector run from about 1.5 to 4 million, depending on who is counted.

Their work has no digital tools. Households don't know when the kabadiwala will come, so recyclables end up in the bin. Collectors walk lanes where nobody has anything ready. Many read little, so an app that asks for an email and a password is already out of reach. And nobody records what they collect, so their work is invisible to the city and to lenders.

We wanted to fix the loop, starting from the person who is hardest to design for.

## What we built

**For households:** book a pickup in seconds. Pick one of the next seven days and a two-hour slot, say or type "kal shaam 5 kilo raddi" to an assistant that proposes a booking, or photograph the pile and let the app pre-fill what it sees. Track the pickup, see how far away the kabadiwala is, and get a printable receipt.

**For kabadiwalas:** an admin prints a QR card; the collector scans it once and stays signed in, with no email and no password. The screen is Hindi-first with big icons. A voice assistant answers questions about their day ("is mahine kitna kamaya?") and gives spoken turn-by-turn directions ("150 मीटर बाद दाएँ मुड़ें"). Nothing is saved until the collector says or taps "haan". Collectors who read can sign in with a phone number and password instead.

**For the city:** impact is counted only from weights the collector measured, and households can confirm them. The methodology page lists every formula, emission factor and its source, and what we do not claim. Each collector gets a monthly statement (kilos, rupees, how many pickups the household confirmed) that can serve as income proof, with no household addresses on it.

## Architecture

```
React PWA (S3 + CloudFront)
        |
 API Gateway ── Cognito authorizer (email, Google, QR-card custom auth)
        |
     Lambda (Node 22, arm64) ── DynamoDB (single table)
        |                          |
 createRequest → SQS ──→ dispatch Lambda ←── EventBridge (every 5 min)
                              |
                  Amazon Location Service
              (OptimizeWaypoints, CalculateRoutes, map tiles)

Voice:  phone mic → Lambda → Transcribe (Hindi) → language model → reply → Polly (Hindi)
Photo:  household photo → Lambda → Bedrock vision, or Rekognition labels as the backup
```

One infrastructure template (AWS SAM) defines all of it: about 40 functions, the table, queues, Cognito pool and clients, CloudFront, maps, alarms and a dashboard.

## The AWS decisions that mattered

**DynamoDB with conditional transactions.** A pickup moves `OPEN → ASSIGNED → EN_ROUTE → PICKED`, and several things can try to move it at once: the dispatcher, a collector tapping "I'll take it", an admin assigning by hand, a household cancelling. Every transition is a `TransactWriteItems` call with a condition on the current status, so the loser gets a clean 409 instead of a double assignment. Confirming a pickup writes the request and two impact counters in one transaction, so a retry can never double-count kilos. We got exactly-once behaviour without writing a single lock.

**Passwordless login with Cognito custom auth.** The QR card holds a one-time code. We store its hash on the collector's record; the verify trigger consumes it with a conditional update, so it works once. Issuing a new card replaces the old one, and blocking a lost phone signs the collector out everywhere. The collector never sees a password.

**Amazon Location Service for routing.** `OptimizeWaypoints` orders a collector's stops in one call, and we store the order requests arrived in beside it, so the app can show "2.1 km instead of 3.4 km". For directions, `CalculateRoutes` with turn-by-turn returns the route line and steps in one call, with Pedestrian and Scooter travel modes. We derive each turn's left or right from the line's geometry and write the Hindi phrase ourselves, so the spoken directions don't depend on the API's wording. If the routing call fails we fall back to a nearest-neighbour ordering with 2-opt, so a dispatch never fails because of a map service.

**Polly and Transcribe for Hindi, with fallbacks everywhere.** Polly's neural Hindi voice (Kajal) speaks every reply, and common phrases are cached on the phone so they cost nothing the second time. Speech-to-text tries Transcribe first. The "brain" tries Amazon Bedrock, then a free Groq model, then keyword rules. Each step is logged, so we can see which one answered. The model never writes the sentence the collector hears and never changes data: it picks a tool, the Lambda validates it and builds the reply from real data, and the phone performs the action only after a yes.

**One template, reviewable deploys.** We never ran a blind deploy. Every release was a CloudFormation change set we read first (adds, modifications, removals), then executed. It caught nothing dramatic, which is the point.

## Things that fought back

- **"The request can't be seen on the kabadiwala side."** Our first matching rule gave a request to a collector only if it fell in one of that collector's listed map cells, and only after enough weight had piled up. A booking from a new town matched nobody. We moved to distance: every collector has a service radius around their home, requests are offered 12 hours before their slot, and any collector can claim unassigned requests from a nearby board. Households are now told when nobody covers their address.
- **Maps.** Creating a key for the newer Amazon Location map actions failed with an error that didn't name the action, so we moved to the older map resource. Then the key's referer restriction returned 403s for MapLibre's web worker, because a blob worker doesn't send our site as its referer. Serving the worker script from our own domain fixed it.
- **Bedrock access.** Our account stayed in "being verified" for more than a day. Because the model sits behind one function with fallbacks, the product kept working on keyword rules and Rekognition labels the whole time.
- **A subtle bug:** the keyword fallback for "cancel" matched `radd`, which is also the start of *raddi*, the word for waste. "5 kilo raddi" kept cancelling pickups until a test caught it.

## Testing and cost

The project has 90 unit tests (batching, routing, handlers with mocked AWS calls, card login, voice intents, scheduling, directions), 33 browser tests at phone size with accessibility checks, and a smoke test that runs the whole loop against the deployed stack: request, dispatch, route, pickup, household confirmation and impact.

Idle, the stack costs cents a month. Voice and photo features have per-user daily caps, Lambda logs are kept 30 days, and a public judge demo creates throwaway collectors with a daily limit and data that expires after three days, kept out of the real impact totals.

## What we don't claim

Our CO₂ factors come from the US EPA's WARM model applied to Indian conditions, so they are estimates. We have not run a field pilot yet: the numbers on the live dashboard come from our test pickups. We have not tested the microphone and GPS directions on a wide range of low-cost phones. The full plan, the survey we wrote for kabadiwalas, and the limits are in the repository.

## What's next

A one-neighbourhood pilot with five kabadiwalas and a resident welfare association; an Android wrapper for background location; more Indian languages through Bhashini; and an IVR phone line for collectors with basic phones.

## What we learned

Designing for the person who reads least made everything simpler for everyone: a card instead of a password, a button instead of a form, a spoken sentence instead of a screen. And on AWS, the services that let us fail safely, with conditional writes, change sets, and fallbacks behind a single function, mattered more than any individual feature.

*Written by [Author name]. #AWS #Serverless #AmazonLocationService #DynamoDB #Cognito #AmazonPolly #Sustainability*
