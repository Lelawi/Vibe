# Vibe – Architekturüberblick

## Prinzip
Collector, Datenbank und App sind komplett getrennt und reden nur über
die `events`-Tabelle in Supabase miteinander.

## Komponenten
- **Collector** (`collectors/`): sammelt Events, läuft automatisch
  per GitHub Actions (zeitgesteuert).
- **Datenbank**: Supabase/Postgres, speichert alle Events zentral.
- **App** (`app/`): React Native/Expo, liest nur aus der Datenbank.

## Aktueller Stand
- Supabase-Projekt + `events`-Tabelle existieren
- Noch kein Collector, noch keine App
