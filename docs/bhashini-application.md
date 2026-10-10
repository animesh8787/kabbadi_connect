# Text for the Bhashini API key form

**Where will you use this key:** Web (the app is an installable web app / PWA; calls to Bhashini are made from our server, not from the browser)

**Details box:**
Kabadi Connect is a Progressive Web App at https://d7oz11dsxwlh1.cloudfront.net. The mobile browser records short Hindi voice clips (hold-to-talk) and sends them to our own AWS Lambda backend, which calls Bhashini ASR and TTS. The API key is stored encrypted on the server and is never sent to the browser.

**Average API calls per day:** 200

**Use case description (about 200 words):**
Kabadi Connect is a hackathon project (WeMakeDevs x AWS, Environmental Hacks, Waste and Energy track) built by a student at Thapar Institute of Engineering and Technology, Patiala. It connects households with kabadiwalas, the informal scrap collectors who do much of India's recycling. Many kabadiwalas read little and use low-cost phones, so a screen full of text and a password are real barriers. We are adding a Hindi voice assistant so a collector can use the app by speaking. They hold a button and say things like "agla ghar kahan hai" (where is the next house), "paanch kilo kagaz" (five kilos of paper) or "ghar par koi nahi" (nobody is home). We need Bhashini ASR to turn the Hindi speech into text and Bhashini TTS to read the answer back, for example the next address or the weight we heard, and to ask the collector to say yes or no before anything is saved. Clips are short, usually under ten seconds, and are not stored after transcription. Expected usage during the hackathon and a small pilot is a few hundred calls per day. We would like to add other Indian languages later, using Bhashini, so that collectors in other regions can use the app in their own language.

**Supporting document:** print `README.md` (or the live page https://d7oz11dsxwlh1.cloudfront.net/methodology) to PDF and upload it.
