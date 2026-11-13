# 🎵 Song-Studio

Eine einfache Chat-Oberfläche, mit der Schülerinnen und Schüler mit Googles Musikmodell **Lyria 3.5** Songs erzeugen können – inklusive Änderungswünschen im Chat.

## Aufbau

| Teil | Wo | Was |
|---|---|---|
| `index.html` | GitHub Pages (öffentlich) | Anmeldemaske und Chat. Enthält **keine** Geheimnisse. |
| `server/` | Google Cloud Run | Prüft das Passwort, zählt das Tageslimit und ruft Google Lyria auf. API-Key und Passwort liegen verschlüsselt im Google Secret Manager. |

Der API-Key steht **nie** im Code oder im Repository.

## Kosten

- Lyria 3.5: ca. 0,08 $ pro Song (auch jede Änderung ist ein neuer Song).
- Tageslimit: `DAILY_LIMIT` (Standard 65 Songs ≈ 5 €), zusätzlich Ausgabenlimit im Google-Projekt.
- Cloud Run, Secret Manager und GitHub Pages: im kostenlosen Rahmen.

## Einrichten (in der Google Cloud Shell)

```bash
git clone https://github.com/Philipp-byte/song-generator.git && cd song-generator
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
printf '%s' 'HIER-DEN-API-KEY' | gcloud secrets create gemini-api-key --data-file=-
printf '%s' 'HIER-DAS-PASSWORT' | gcloud secrets create song-password --data-file=-
gcloud run deploy song-generator --source server --region europe-west3 \
  --allow-unauthenticated --max-instances 1 --timeout 300 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest,PASSWORD=song-password:latest \
  --set-env-vars DAILY_LIMIT=65
```

Danach die Server-Adresse in `index.html` bei `SERVER_URL` eintragen.

## Passwort ändern

```bash
printf '%s' 'NEUES-PASSWORT' | gcloud secrets versions add song-password --data-file=-
gcloud run services update song-generator --region europe-west3 --update-secrets PASSWORD=song-password:latest
```

Alle bisherigen Anmeldungen werden dadurch ungültig.

## Lokal testen (ohne Kosten)

`server/.env.test` anlegen:

```
MOCK=1
PASSWORD=test123
PORT=8787
```

Dann `node --env-file=server/.env.test server/index.js` und `python -m http.server 8000` starten und `http://localhost:8000` öffnen.
