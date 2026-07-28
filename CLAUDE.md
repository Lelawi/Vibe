# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Vibe is a free mobile app that aggregates local events (concerts, comedy,
workshops, markets, yoga, etc.) in one place, starting with Munich. It is in
early development — no released app yet. Primary language for docs, UI text,
and code comments in this repo is German; match that when adding
user-facing strings or docs.

## Repository structure

This is **not** an npm workspace — `app/` and `collectors/` are independent
Node projects with their own `package.json` and `node_modules`, connected
only through the shared Supabase database. Always `cd` into the relevant
subdirectory before running npm commands.

- `app/` — React Native / Expo app (the mobile client, reads only from Supabase)
- `collectors/` — scrapers/API clients that populate Supabase, run on a schedule via GitHub Actions
- `supabase/migrations/` — SQL schema migrations for the shared `events` table
- `docs/` — architecture notes and ADRs

### Architecture principle

Collector, database, and app are fully decoupled and communicate **only**
through the `events` table in Supabase (see `docs/architecture.md`). Never
have the app call collector code directly or vice versa — all data flow goes
through Supabase.

## Commands

### App (`app/`)

```
cd app
npm install
npm start          # expo start
npm run web         # expo start --web
npm run android      # expo start --android
npm run ios          # expo start --ios
./start-tunnel.sh    # expo start --tunnel, auto-retries on ngrok failures (used when developing from a browser/iPhone with no local Xcode/Android Studio)
```

No lint or test scripts are configured for the app.

Env vars (`.env`, not committed): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` (see `app/lib/supabase.ts`).

**Expo version note:** the app targets Expo SDK 54 / a recently changed Expo
API surface. Per `app/AGENTS.md`, consult the versioned docs at
https://docs.expo.dev/versions/v57.0.0/ before writing Expo-related code
rather than relying on older training data.

### Collectors (`collectors/`)

```
cd collectors
npm install
npm run backstage       # scrape/fetch Backstage München events
npm run muenchenticket   # scrape muenchenticket.de (Algolia-backed)
npm run lostweekend       # scrape lostweekend.de
npm run muenchenevent     # scrape muenchenevent.de
npm run dedup             # run mark_duplicate_events() Postgres RPC
```

Each collector is run independently (see `.github/workflows/collect-all.yml`,
scheduled twice daily via cron). There is no single "run all" script locally
— run each `npm run <source>` command in turn, then `npm run dedup` last so
newly inserted events get deduplicated.

Env vars (`.env`, not committed): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(service role, not anon — collectors write directly to the `events` table).

No lint or test scripts are configured for collectors.

## Collector architecture

Each source under `collectors/sources/<name>/index.ts` is a standalone
script following the same shape:

1. Fetch raw events from the source's API or HTML page (`fetch` + `cheerio`
   for HTML scraping, e.g. `lostweekend`, `muenchenevent`).
2. Normalize each raw event into the shared `events` row shape (`title`,
   `category`, `start_date`, `start_time`, `location_name`, `address`,
   `latitude`/`longitude`, etc.), generating a stable `source_id` like
   `"<source>-<external-id>"` used as the upsert conflict key.
2. Geocode venues via `collectors/core/geocode.ts` (`getCoordinates`), which
   caches results in the `venue_coordinates` Supabase table and only calls
   the Nominatim API (rate-limited to 1 req/sec) for unknown venues.
3. Upsert normalized events into the `events` table with
   `onConflict: 'source_id'`.

Dedup runs separately (`collectors/sources/dedup/index.ts`) by calling the
`mark_duplicate_events` Postgres RPC (defined in Supabase, not in this repo)
after all sources have written their events — it sets `duplicate_of` on
rows the app then filters out.

When adding a new collector source, follow this same pattern (fetch →
normalize → geocode → upsert) and add a corresponding `npm run <source>`
script plus a step in `.github/workflows/collect-all.yml`.

## App architecture

- Expo Router (`app/app/*.tsx`) with three screens: event list (`index.tsx`),
  event detail (`event/[id].tsx`), and map (`map.tsx`).
- The app is **read-only** against Supabase: RLS on `events` only grants a
  public `select` policy (see `supabase/migrations/0001_initial_schema.sql`);
  writes happen exclusively from collectors using the service role key.
- Queries always filter `duplicate_of is null` and (for upcoming events)
  `start_date >= today` — replicate both filters in any new query against
  `events`.
- The map screen renders differently per platform: `map.tsx` shows a
  "not available on web" message and delegates to `components/MapNative.tsx`
  (native) vs `components/MapNative.web.tsx` (web stub) — Expo's
  platform-extension file resolution picks the right one automatically.
- Dark theme is hardcoded inline via `StyleSheet.create` (background `#000`,
  cards `#141414`, accent `#0af`) rather than a theme system — match this
  style when adding UI.
