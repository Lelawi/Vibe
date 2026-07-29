# Collectors

This folder contains source collectors that fetch or scrape event listings and normalize them into the shared `events` table.

Guidelines
- Prefer official APIs (Ticketmaster, TicketTailor, Facebook Graph) to scraping.
- Check `robots.txt` and Terms of Service before enabling scrapers.
- Use `getCoordinates()` in `collectors/core/geocode.ts` to geocode venue names and cache results.
- All collectors should export an async `run()` function and support being invoked directly.

Run a single collector (example):
```bash
cd collectors
npm run ticketmaster
```

Run all collectors (sequential) with:
```bash
cd collectors
npm run collect-all
```

Environment variables
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — required to upsert events
- Collector-specific keys like `TICKETMASTER_API_KEY`, `FACEBOOK_ACCESS_TOKEN` may be required
