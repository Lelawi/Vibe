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
- `supabase/migrations/` — SQL schema migrations for the shared `events` table. Applied
  directly via the Supabase CLI (`npx supabase db push --db-url "$SUPABASE_DB_URL"` from
  the repo root — no `supabase init`/`link` needed, `--db-url` alone is enough) instead of
  pasting SQL into the dashboard manually. `SUPABASE_DB_URL` (2026-08-12, `app/.env`, not
  committed) is the **Session pooler** connection string from Supabase's "Connect" dialog
  → Direct → Session pooler (not "Direct connection" — that defaults to IPv6, unreliable
  on this network; not "Transaction pooler" — incompatible with some migration DDL). All
  42 existing migrations were already applied by hand before this was set up, so their
  history was backfilled with `supabase migration repair --status applied <versions...>`
  rather than re-run — only genuinely new migrations going forward hit `db push` for real.
  Two legacy files (`0035a_...`, `0035b_...`) don't match the CLI's `<number>_name.sql`
  pattern and are silently skipped by every CLI command; harmless (already applied,
  already tracked won't matter since the CLI never sees them to re-check), just don't
  expect the CLI to notice if they ever needed changing.
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
not as a separate workflow step. The entry's `name` must equal the source's
`source_id` prefix: `collect-all.ts` counts the rows each source wrote in the
run (via `source_checked_at`), writes a table to the GitHub step summary,
emits a `::warning::` for sources with an error or 0 rows (`seasonal: true`
suppresses that), logs every run to the `collector_runs` table (shown in the
weekly report), and gives each source a timeout (`timeoutMin`, default 15).
The job only fails when more than half of the sources deliver nothing, so a
single blocked site shows up as a warning instead of a daily failure mail. Several source files exist under
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
`mark_duplicate_events` Postgres RPC (current definition:
`supabase/migrations/0049_fast_dedup.sql`) after all sources have written
their events — it sets `duplicate_of` on rows the app then filters out. It
only looks at days with upcoming/running events and normalizes titles once
per row; keep it that way — the old per-pair version exceeded PostgREST's 8s
statement timeout and failed daily from 2026-08-27 to 2026-09-30. Dedup
updates set the transaction flag `vibe.skip_source_check` so they don't
touch `source_checked_at`.

When adding a new collector source, follow this same pattern (fetch →
normalize → geocode → upsert) and add a corresponding `npm run <source>`
script plus an entry in `collect-all.ts` (see above).

Dates and times: `events.start_date`/`start_time` are naive Europe/Berlin
wall-clock values. Use the helpers in `collectors/core/timezone.ts` instead of
`toISOString()` (which yields UTC and put ~470 events 1–2h too early):
`isoToBerlinWallClock()` for ISO timestamps from a source, `berlinToday()` for
"today", and `resolveYearlessDate()` for dates without a year ("18.07.") —
it keeps recently past dates in the current year instead of pushing them
into the next one (that created >80 phantom events). The app has the same
`berlinToday()` in `app/lib/berlinDate.ts`.

`source_id` must be stable across runs: never build it from a value that
changes daily (e.g. the rolling start date of a running exhibition — that
gave muenchen-stadtportal one new row per exhibition per day).

## App architecture

- Expo Router (`app/app/*.tsx`) with three screens: event list (`index.tsx`),
  event detail (`event/[id].tsx`), and map (`map.tsx`).
- The app is **read-only** against Supabase: RLS on `events` only grants a
  public `select` policy (see `supabase/migrations/0001_initial_schema.sql`);
  writes happen exclusively from collectors using the service role key.
- Large offline caches (event list, venue lists) go through
  `app/lib/largeCache.ts` (IndexedDB on web), never plain AsyncStorage: on
  web AsyncStorage is localStorage (~5 MB), which the lists overflowed —
  and a full localStorage also broke small stores like favorites. Small
  stores update listeners first and wrap `setItem` in try/catch.
- Supabase caps every request at 1000 rows: page with `.range()` after a
  count (see `lib/fetchAllVenues.ts`, `lib/fetchMapEvents.ts`), and throw on
  any error instead of returning `[]` so callers keep their last good state.
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
  stored client-side in `app/lib/followedOrganizers.ts`). Genre matching
  (`push_filters.genres`) is matched server-side too — the grouping heuristic
  (`normalizeGenreGroup`) lives in `app/lib/genreGroup.ts` and is deliberately
  1:1-copied to `collectors/core/genreGroup.ts` (collectors can't import from
  `app/`, see Architecture principle above), same pattern as
  `canonicalizeVenue.ts` below. Location matching uses
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
  1st, no rollover). `MONTHLY_BUDGET` in the script self-limits to 960/month
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

## Feedback review and weekly report

User reports (closures, venue data, events, missing items, app feedback) are
prechecked by the daily workflows (`precheck-reports.yml`,
`promote-feedback.yml`) and cloud routines (see
`docs/claude-routine-prompts.md`). Open cases are handled in the live report
artifact https://claude.ai/artifact/5Zm1CqVKvXeUMuzeYWiehY: it loads all open
cases directly from Supabase on open (via the owner's Supabase connector — no
key in the page), offers direct fixes (venue category via `type_override`,
beer price, opening hours, name, closed, event link) and a "Rückmeldung an
Claude" field that turns free text into one whitelisted action to confirm, or
stores it as `review_note` prefixed `[Hinweis vom Owner]` for the next Claude
session to pick up. The weekly routine "Vibe - Wöchentliche
Feedback-Zusammenfassung" (Mondays, email + push) only summarizes and links
that page; it doesn't need to regenerate it. Venue category changes must set
both `type` and `type_override`, otherwise the weekly OSM run reverts them.
