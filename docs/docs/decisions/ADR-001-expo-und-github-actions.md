# ADR-001: Expo für die App, GitHub Actions für den Collector-Zeitplan

## Kontext
Entwicklung erfolgt browserbasiert (iPhone + eingeschränkter Laptop,
kein privater Rechner).

## Entscheidung
- App: React Native mit Expo (nicht reines React Native)
- Collector-Zeitsteuerung: GitHub Actions

## Begründung
Expo erlaubt App-Entwicklung/-Builds komplett über Browser/Expo-Go-App
auf dem iPhone, ohne Xcode/Android Studio lokal zu installieren.
GitHub Actions kann kostenlos zeitgesteuert Code ausführen, ohne dass
ein eigener Server läuft.

## Alternativen erwogen
- Reines React Native: verworfen, da lokales Xcode nötig wäre
- Supabase-eigene Zeitsteuerung (pg_cron): möglich, aber vermischt
  "wo läuft Code" mit "wo liegen Daten"
