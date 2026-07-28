# Vibe – Architekturüberblick

## Prinzip
Collector, Datenbank und App sind komplett getrennt und reden nur über
die `events`-Tabelle in Supabase miteinander.

## Komponenten
- **Collector** (`collectors/`): sammelt Events, läuft automatisch
  per GitHub Actions (zeitgesteuert, `collect-all.yml`).
- **Datenbank**: Supabase/Postgres, speichert alle Events zentral.
- **App** (`app/`): React Native/Expo, liest nur aus der Datenbank.

## Distribution
Die App wird primär als **Web-App/PWA** verteilt (statischer Web-Export via
`npx expo export --platform web`, gehostet auf GitHub Pages, automatisch
deployed durch `.github/workflows/deploy-web.yml` bei Push auf `main`). Das
wurde bewusst statt eines nativen TestFlight-Builds gewählt: kein
kostenpflichtiger Apple-Developer-Account nötig, keine Abhängigkeit von
Tunnel-/ngrok-Verbindungen zum Testen auf dem iPhone. Auf dem iPhone via
Safari "Zum Home-Bildschirm hinzufügen" installierbar.

Native Builds (iOS/Android über EAS) sind technisch vorbereitet
(`app/eas.json`, `eas:build:*`-Scripts), aber nicht aktiv genutzt, da dafür
ein kostenpflichtiger Apple Developer Account nötig wäre.

## Aktueller Stand
- Supabase-Projekt + `events`-Tabelle existieren, Collector laufen produktiv
- App existiert und läuft als deployte Web-App/PWA
