# Pilot plan: Kabadi Connect in one neighbourhood

Everything below is a **plan and set of targets**, not results. Numbers marked (research) come from `docs/research.md`; the rest are targets to test.

## Scope
- **Where:** one resident welfare association (RWA) in Rohini, Delhi, or around Thapar in Patiala (whichever RWA agrees first).
- **Who:** 5 kabadiwalas already working the area, about 200 households, 4 weeks.
- **Not in the pilot:** payments inside the app (cash stays), SMS, new cities.

## Before week 1 (setup, 2 to 3 days)
1. Meet the RWA committee: explain the idea, agree a notice board poster and a WhatsApp message carrying the link or QR code (`npm run qr`).
2. Run the field survey from `docs/research.md` with the 5 kabadiwalas and 20 households; record the answers as the baseline.
3. Create each collector in the admin screen (name, phone, the areas they cover) and **print one QR card each**. A collector scans the card once and stays signed in.
4. Check the phones: each kabadiwala needs a phone with a browser and a camera. Try the voice assistant on each phone in the street (microphone permission, noise).
5. Verify the e-waste recycler list against DPCC and confirm the default rates with the 5 collectors.

## Weekly plan
| Week | Goal | What we do |
|---|---|---|
| 1 | Everyone can use it | Walk each collector through the card and the mic button. Fix confusing screens the same day. |
| 2 | Real volume | Households book through the poster/WhatsApp link. Daily check of open requests and stale batches. |
| 3 | Trust | Encourage household confirmation of weights; share each collector's monthly statement with them. |
| 4 | Decide | Re-run the survey questions, compare to the baseline, write up results and the cost per pickup. |

## What we measure (the app already records all of it)
| Metric | Where it comes from |
|---|---|
| Pickups completed, kg by material | Dashboard and `/public/impact` |
| Share of weights confirmed by households | `ackKg` / `kg` on the dashboard |
| Segregation quality | Collector's good/mixed rating, dashboard |
| Km walked vs request order | `km` / `naiveKm` per batch |
| Collector income per trip and per month | Monthly statement (ledger) |
| Voice use vs button use | Assistant log lines (`via`, `stt`, `tts`) |
| Empty trips before vs after | Survey baseline vs week 4 |

## Targets to test (not promises)
- At least 60% of booked pickups completed within their window.
- At least half of completed pickups confirmed by the household.
- Collectors report fewer empty trips than their own baseline.
- At least 3 of 5 collectors use voice for one or more actions without help by week 3.

## Cost and risks
- **AWS cost:** about $5 to $30 a month at pilot size, voice and photo being the main variable (caps per user: 200 voice turns, 20 photos a day). Budget alarm to be turned on before launch.
- **Literacy and device risk:** cards, big icons, Hindi voice, and every voice action has a button. Lost phone or card: admin blocks the collector and prints a new card.
- **Trust risk:** only collector-measured weights count; households can dispute by not confirming; the method is public (`/methodology`).
- **Data risk:** statements carry no addresses; photos and voice clips are not stored.
- **Not yet solved:** SMS for basic phones (needs DLT registration), downstream tracking of where material is sold.

## After the pilot
Android app (Capacitor wrapper of this PWA, with push notifications and background location), an IVR line for basic phones, more languages through Bhashini, and a second neighbourhood.
