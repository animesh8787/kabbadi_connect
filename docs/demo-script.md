# 3-minute demo script (v2: "Ramesh ji")

Logins are in `.seed-credentials.json` after `npm run seed`. Record on a phone-sized window.
Before recording: `npm run card -- collector1@kabadi.example.com` (the link is single-use, so open it on the phone you record with), and make sure Bedrock access works (see README) so voice uses the model.

| Time | Show | Say |
|---|---|---|
| 0:00-0:25 | Real clip or photo of a kabadiwala; one sourced stat from `docs/research.md` | "Kabadiwalas do much of India's recycling with no digital tools, and many can't use an app that needs an email and a password." |
| 0:25-0:50 | Admin > Collectors: add Ramesh, tap his areas, print the QR card | "An admin or RWA prints one card for each collector." |
| 0:50-1:15 | Phone camera scans the card: app opens in Hindi, already signed in | "He scans once and stays signed in. No typing." |
| 1:15-1:40 | Household app (second window): photo of a pile fills the chips; schedule | "A household photographs the pile; AI suggests materials and weight." |
| 1:40-2:20 | Ramesh holds the mic: "agla ghar kahan hai", app speaks the address; "shuru karo", "haan"; "paanch kilo kagaz, achha alag tha", app repeats, "haan" | "Everything by voice, in Hindi. Nothing is saved until he says yes." |
| 2:20-2:40 | Household taps "weights look right"; Statement tab shows kg, rupees and verified pickups | "Both sides confirm. His monthly statement is income proof." |
| 2:40-3:00 | Dashboard with segregation rate, kg, CO2e; open /methodology | "Impact is counted only from confirmed weights, and the method and its limits are public." |

If Bedrock is still unavailable at recording time, the assistant answers common phrases from keyword rules (say "agla ghar", "shuru karo", "paanch kilo kagaz"); photo fill will show an error, so skip that beat.
