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
npm run build:web    # expo export --platform web -> app/dist, static PWA build for hosting
```

No lint or test scripts are configured for the app.

**Do not add `expo start --tunnel` or the `@expo/ngrok` dependency back.**
This was tried early on to test on a phone over the internet, but (a) the
corporate network blocks ngrok's tunnel at the OS level regardless of
network, so it never worked, and (b) `ngrok.exe` got flagged by corporate
CERT/EDR as a possible C2 tunneling tool (a legitimate detection — ngrok
really is abused for that — it's just also a real Expo dev dependency with
no way to tell the two apart automatically). The PWA/GitHub Pages
distribution below fully replaces the need for tunneling.

Env vars (`.env`, not committed): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` (see `app/lib/supabase.ts`), `EXPO_PUBLIC_VAPID_PUBLIC_KEY` (see Push notifications below). These are baked into the web build at build time, so they must also be set as repo secrets for `.github/workflows/deploy-web.yml`.

**Distribution:** the primary distribution channel is the web build (PWA,
installable via "Add to Home Screen" in Safari/Chrome) deployed to GitHub
Pages by `.github/workflows/deploy-web.yml` on every push to `main` that
touches `app/**`. Native builds (EAS/TestFlight) are possible via the
`eas:build:*` scripts below but require a paid Apple Developer account and
are not currently set up.

**Expo version note:** the app targets Expo SDK 54 (`expo: "^54.0.0"`). Ignore
any reference to Expo v57 docs — that was a stale/incorrect leftover from an
earlier AI-assisted edit and has been corrected in `app/AGENTS.md`.

### Collectors (`collectors/`)

```
cd collectors
npm install
npm run collect-all      # runs every active source in collect-all.ts, in sequence
npm run dedup             # run mark_duplicate_events() Postgres RPC — always run last
npm run backstage         # or run a single source directly, e.g. for debugging
```

`collect-all.ts` is the single source of truth for which collectors run
automatically (imported and listed in its `sources` array) — the GitHub
workflow (`.github/workflows/collect-all.yml`, scheduled once daily via cron —
reduced from twice daily 2026-08-07 after eventim/milla started returning
403s more often, to cut request volume against their rate limits)
just calls `npm run collect-all` followed by `npm run dedup`. When adding a
new source to the automatic run, add it to `collect-all.ts`'s `sources` array,
not as a separate workflow step. Several source files exist under
`collectors/sources/` but are deliberately **not** in `collect-all.ts` — see
the comment above the `sources` array for why (missing/paid API keys, no
real public data source found, etc.).

Env vars (`.env`, not committed): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(service role, not anon — collectors write directly to the `events` table).
`collect-all.ts` falls back to `../app/.env` if `collectors/.env` doesn't
exist, so a single `.env` in `app/` covers both projects locally. Push
notification sending additionally needs `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — see Push notifications below. The
Google ratings collector additionally needs `GOOGLE_PLACES_API_KEY` — see
Google ratings below.

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
  `start_date >= today OR end_date >= today` — the `end_date` half keeps
  multi-day events (exhibitions, Auer Dult) visible for their whole run
  instead of dropping them the day after they start. Replicate both filters
  in any new query against `events`.
- The map screen (`map.tsx`) just renders `<MapNative />`; Expo's
  platform-extension file resolution automatically picks
  `components/MapNative.tsx` (native, `react-native-maps`) on iOS/Android or
  `components/MapNative.web.tsx` (web, `react-leaflet` + OpenStreetMap tiles,
  no API key) on web. The web version lazy-loads the actual Leaflet map
  (`components/LeafletMapView.web.tsx`) client-side only, since Leaflet
  touches `window`/`document` at import time and would break the static
  web-export's server-side prerender step otherwise.
- Dark theme is hardcoded inline via `StyleSheet.create` (background `#000`,
  cards `#141414`, accent `#0af`) rather than a theme system — match this
  style when adding UI.
- The main list's `FlatList` renders a `ListRow` union (`{ kind: 'featured' }`
  or `{ kind: 'group' }`), not `eventGroups` directly — a "✨ Empfohlen für
  dich" image-forward carousel (inspired by Posh/DICE's discovery feeds) is
  injected as the first row when there are ≥2 upcoming events with images.
  It's a normal scrolling row, not part of the pinned header, so it scrolls
  away like any other card instead of permanently eating screen space.

## Push notifications

Web Push (no Firebase/FCM account, just the standard browser Push API +
self-generated VAPID keys). Only works on the PWA (web), not on native — no
native push setup exists.

- `supabase/migrations/0005_push_notifications.sql` — `push_subscriptions`
  (one row per browser subscription, keyed by `endpoint`), `push_favorites`
  (which events a subscription wants a reminder for, `notified_at` marks
  ones already sent), `push_filters` (saved category/genre/location filters
  per subscription for "new matching event" notifications). The app has no
  login, so a device is identified purely by its push `endpoint`; RLS grants
  `anon` insert-only on `push_subscriptions` and full read/write on
  `push_favorites`/`push_filters` — `subscription_id` (a random UUID) is the
  de facto access token, not real per-user auth. Don't add a `select` policy
  to `push_subscriptions` for `anon` without thinking through why it was
  deliberately left off.
- `app/lib/pushNotifications.ts` — client side: subscribe via
  `pushManager.subscribe()`, insert the subscription into Supabase, cache the
  returned `id` in `AsyncStorage` (avoids needing an update/select policy —
  see migration comments), and sync favorites/filters to the server whenever
  they change while push is enabled.
- `app/public/service-worker.js` — `push` event shows the notification,
  `notificationclick` focuses/opens the app at the event's URL.
- `collectors/notifications/index.ts` — the actual sender, run on a schedule
  (`.github/workflows/send-notifications.yml`, every 15 min) via
  `npm run send-notifications` in `collectors/`. Two jobs: favorite reminders
  (events starting within the next 3h) and filter matches (events added
  since a subscription's `last_checked_at` that match its saved
  categories/locations/organizers — "follow an organizer" like
  Bandsintown/DICE, toggled from the organizer row on the event detail page,
  stored client-side in `app/lib/followedOrganizers.ts`). Genre matching is stored client-side
  (`push_filters.genres`) but not yet matched server-side — genre grouping
  (`normalizeGenreGroup`) is a client-only heuristic in `app/app/index.tsx`
  that hasn't been ported. Location matching uses
  `collectors/core/canonicalizeVenue.ts`, a deliberate 1:1 copy of
  `app/lib/venue.ts`'s `canonicalizeVenue` — collectors can't import from
  `app/` (see Architecture principle above), so keep both in sync by hand if
  the heuristic changes.
- VAPID key pair is self-generated (`npx web-push generate-vapid-keys` in
  `collectors/`), not tied to any third-party account. Required as repo
  secrets for both `deploy-web.yml` (`VAPID_PUBLIC_KEY` → baked in as
  `EXPO_PUBLIC_VAPID_PUBLIC_KEY`) and `send-notifications.yml`
  (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — a
  `mailto:` contact address, required by the Web Push protocol).

## Google ratings

The one deliberate exception to "no paid APIs" (see below) — a small,
hard-budgeted use of the official Google Places API (New), never scraping
Google Maps/Reviews directly (that would violate Google's ToS regardless of
technique, be it HTML scraping or repeatedly querying it through a search
tool).

- `supabase/migrations/0024_venues_google_rating.sql` — adds
  `google_place_id`, `google_rating`, `google_rating_count`,
  `google_rating_checked_at` to `venues`.
- `collectors/sources/google-ratings/index.ts`, run daily
  (`.github/workflows/google-ratings.yml`) via `npm run google-ratings` in
  `collectors/`. Resolves each venue's `google_place_id` once via Text Search
  (cheap, id-only field mask), then fetches `rating`/`userRatingCount` via
  Place Details — that field pushes Place Details into the pricier
  "Enterprise" SKU, which only has 1,000 free requests/month (resets on the
  1st, no rollover). `MONTHLY_BUDGET` in the script self-limits to 900/month
  as a safety margin, processing up to `DAILY_BATCH` (30) oldest-checked
  venues per run — full rotation across ~2,500 venues takes ~3 months, then
  repeats indefinitely to keep ratings from going stale.
- The real safety net against unexpected charges is **not** this script's
  self-limiting logic but a hard quota limit set in the Google Cloud Console
  on the Places API itself (Cloud Billing *budgets* only alert, they don't
  block requests — *quotas* actually stop them). Never remove or loosen
  `MONTHLY_BUDGET` without confirming the Cloud Console quota is still set
  at least as conservatively.
- `GOOGLE_PLACES_API_KEY` required as a repo secret for
  `google-ratings.yml`. Setup (Google Cloud project, enabling Places API
  (New), billing account, API key, hard quota limit) is manual and owned by
  the project owner — not something this repo or Claude Code can provision.
