# 🎵 Song-Studio

Eine einfache Chat-Oberfläche, mit der Schülerinnen und Schüler mit Googles Musikmodell **Lyria 3.5** Songs erzeugen können – inklusive Änderungswünschen im Chat.

## Aufbau

| Teil | Wo | Was |
|---|---|---|
| `index.html` | GitHub Pages (öffentlich) | Anmeldemaske und Chat. Enthält **keine** Geheimnisse. |
| `worker/` | Cloudflare Worker | Prüft das Passwort, zählt das Tageslimit und ruft Google auf. API-Key und Passwort liegen dort als verschlüsselte Secrets. |

Der API-Key steht **nie** im Code oder im Repository.

## Kosten

- Lyria 3.5: ca. 0,08 $ pro Song (auch jede Änderung ist ein neuer Song).
- Tageslimit: `DAILY_LIMIT` in `worker/wrangler.toml` (Standard 65 Songs ≈ 5 €).
- Cloudflare Worker und GitHub Pages: kostenlos.

## Einrichten

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create STORE      # id in wrangler.toml eintragen
npx wrangler deploy
npx wrangler secret put GEMINI_API_KEY      # Key einfügen
npx wrangler secret put PASSWORD            # Passwort für die Schüler
```

Danach die Worker-Adresse in `index.html` bei `WORKER_URL` eintragen.

## Passwort ändern

```bash
cd worker
npx wrangler secret put PASSWORD
```

Alle bisherigen Anmeldungen werden dadurch ungültig.

## Lokal testen (ohne Kosten)

`worker/.dev.vars` anlegen:

```
MOCK=1
PASSWORD=test123
```

Dann `npx wrangler dev` im Ordner `worker` und `python -m http.server 8000` im Hauptordner starten und `http://localhost:8000` öffnen.
