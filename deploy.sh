#!/bin/bash
# Veröffentlicht den Song-Studio-Server bei Google Cloud Run.
# Aufruf in der Google Cloud Shell:  bash deploy.sh
# Voraussetzung: Secrets "gemini-api-key" und "song-password" im Secret Manager.
set -e
cd "$(dirname "$0")"

PROJECT=$(gcloud config get project)
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="$PN-compute@developer.gserviceaccount.com"

echo "== Server darf die Geheimnisse lesen =="
for s in gemini-api-key song-password; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor -q >/dev/null
done

echo "== Server wird gebaut und veröffentlicht (2-4 Minuten) =="
gcloud run deploy song-generator --source server --region europe-west3 \
  --allow-unauthenticated --max-instances 1 --timeout 300 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest,PASSWORD=song-password:latest \
  --set-env-vars DAILY_LIMIT=65 -q

echo
echo "FERTIG! Adresse des Servers:"
gcloud run services describe song-generator --region europe-west3 --format='value(status.url)'
