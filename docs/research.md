# Research notes and field survey

Everything here is either linked to a source I actually read, or marked as a gap. Nothing is estimated from memory.

## Problem evidence (verified sources only)

| Claim | Source | Caveat |
|---|---|---|
| There is no single authoritative count of India's waste pickers; estimates run from about 1.5 to 4 million depending on who is counted | [Hasiru Dala case study](https://tejas.iimb.ac.in/articles/Hasiru%20Dala%20Case%20Study%20Report%20(Part%20A).pdf), [IAWP / WIEGO summary](https://globalrec.org/2025/05/20/organising-and-integrating-the-informal-recycling-sector-in-the-solid-waste-management-sector-india/), [India Water Portal on Delhi](https://www.indiawaterportal.org/articles/down-dumps-delhis-waste-pickers-saga) | Search snippets only; open the PDFs for the method before quoting a number in the video |
| Most studies count waste pickers and leave out small kabadi shops and aggregators | Kabadiwalla Connect presentation, quoted in the same search results | Secondary; find the primary |
| About 90% of India's e-waste is processed by the informal sector; about 45% of surveyed people prefer giving e-waste to kabadiwalas | A 2023 study surfaced by search (title not captured) | **Find and cite the exact paper before using** |
| Delhi has six authorised e-waste dismantlers/recyclers on the 2023 list | [CPCB-approved list hosted by NDMC](https://www.ndmc.gov.in/pdf/cpcb_approved_list_of_e-waste_recyclers_dismantler.pdf), Delhi section (names and addresses are in `packages/shared/src/ewaste-recyclers.json`) | List dated 08-06-2023; check validity with DPCC/CPCB |
| Recycling emission factors | [EPA WARM v16](https://www.epa.gov/system/files/documents/2024-01/warm_management_practices_v16_dec.pdf) | Only corrugated (3.14 MTCO2E/short ton) and the older aluminium-can figure were read; the rest of `factors.json` is placeholder |

**Not yet researched (do before the final write-up):** SWM Rules 2016 provisions on integrating waste pickers; Plastic Waste Management EPR rules; E-Waste (Management) Rules; local scrap rates in Delhi; DPDP Act duties for the voice and photo features.

## Field survey (run 5 to 10 kabadiwalas, about 20 households)

Collect answers on paper or a phone; no names needed. Put the results table in the demo video and the blog.

### Kabadiwalas (read aloud, Hindi; about 10 minutes)
1. आप कितने साल से यह काम कर रहे हैं?
2. आपके पास कैसा फ़ोन है (बटन वाला / स्मार्टफ़ोन)? WhatsApp चलाते हैं?
3. क्या आप हिंदी पढ़-लिख लेते हैं? क्या आवाज़ से फ़ोन चलाना आसान लगेगा?
4. रोज़ कितने घरों में जाते हैं, और कितनी बार खाली हाथ लौटना पड़ता है?
5. रोज़ कितने किलो माल उठाते हैं, और किस भाव (कागज़, प्लास्टिक, लोहा, ई-वेस्ट, काँच)?
6. महीने की औसत कमाई कितनी है? सबसे कम और सबसे ज़्यादा महीने?
7. कमाई का कोई लिखित सबूत है जिससे लोन या कार्ड मिल सके?
8. सबसे बड़ी परेशानी क्या है (कम भाव, रास्ता, पुलिस/निगम, मौसम, ग्राहक न मिलना)?
9. अगर घर वाले पहले से बता दें कि कितना माल है, तो क्या आपका समय बचेगा? कितना?
10. आपको क्या चाहिए: कार्ड स्कैन करके लॉगिन, बोलकर काम, या कुछ और?

### Households
1. आप कबाड़ कहाँ देते हैं और कितनी बार?
2. कबाड़ीवाला कब आएगा, पता होता है? कितनी बार छूट जाता है?
3. क्या कचरा गीला/सूखा अलग करते हैं? ई-वेस्ट का क्या करते हैं?
4. क्या आप पहले से समय बताकर पिकअप बुक करेंगे?
5. क्या फ़ोटो से अंदाज़ा भरवाना आसान लगेगा?
6. आप क्या देखना चाहेंगे: कितना किलो बचाया, कितना पैसा मिला, या कुछ और?
7. क्या कबाड़ीवाले का वज़न आप ख़ुद पक्का करना चाहेंगे?
8. आप क्या मासिक सेवा शुल्क देने को तैयार होंगे, या नहीं?

### Findings template

| Question | Answers (n=) | Quote |
|---|---|---|
| Phone type | | |
| Can read Hindi | | |
| Empty trips per day | | |
| Monthly income range | | |
| Would use voice | | |

## Why voice and card login

A collector who reads little cannot be expected to remember an email and a password. v2 uses a printed QR card (scan once, stay signed in), a hold-to-talk Hindi assistant, large icons, and spoken read-back of every stop. Nothing is changed by voice until the collector says or taps yes. These design choices should be checked against survey questions 3 and 10.
