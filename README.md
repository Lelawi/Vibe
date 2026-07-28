# Vibe

Kostenlose mobile App, die lokale Events (Konzerte, Comedy, Workshops,
Märkte, Yoga u.v.m.) an einem Ort bündelt — Start: München.

## Status
🚧 In Entwicklung — noch keine lauffähige App.

## Struktur
- `app/` – React Native / Expo App
- `collectors/` – sammelt Events aus verschiedenen Quellen
- `supabase/` – Datenbank-Schema
- `docs/` – Architektur & Entscheidungen

## Expo / EAS Build

Zum Erstellen einer installierbaren App auf iOS/Android nutze EAS.

1. Im `app/`-Ordner installieren:
```bash
cd app
npm install
npx eas-cli login
```

2. Projekt initialisieren (nur einmal):
```bash
npx eas build:configure
```

3. Produktions-Builds erstellen:
```bash
npm run eas:build:ios
npm run eas:build:android
```

4. Entwicklerversion erstellen:
```bash
npm run eas:build:dev
```

5. Wenn du Expo Go weiter nutzen willst:
```bash
npm start
```
