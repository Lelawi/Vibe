# Idee: Automatischer Abgleich gefolgter Spotify-Künstler mit Events

Status: **recherchiert, nicht umgesetzt** — braucht eine Entscheidung des
Nutzers, da eine echte Spotify-Developer-App-Registrierung nötig ist (Client-ID),
die nur er selbst anlegen kann.

## Idee
Nutzer verbindet sein Spotify-Konto; die App gleicht seine gefolgten/meist
gehörten Künstler automatisch gegen anstehende Events ab (Titel/Organizer/
Subcategory-Matching) und erinnert automatisch, wenn einer dieser Künstler in
München spielt — ohne dass der Nutzer manuell nach jedem Künstler suchen oder
ihn einzeln favorisieren muss.

## Wichtige Einschränkung (Stand Recherche 2026-07, unbedingt vor Umsetzung neu prüfen)
Spotify hat im Februar 2026 den API-Zugang für neue Integrationen massiv
verschärft:
- **Development Mode ist auf 5 Test-Nutzer begrenzt** (vorher 25) und
  **erfordert einen Spotify-Premium-Account** des Entwicklers.
- Um die App öffentlich für mehr Nutzer freizugeben, wäre "Extended Quota
  Mode" nötig — das setzt ein registriertes Unternehmen **mit mindestens
  250.000 monatlich aktiven Nutzern** voraus. Für ein Hobby-Projekt wie Vibe
  praktisch unerreichbar.

**Konsequenz:** Dieses Feature kann realistisch nur als **Opt-in für eine
Handvoll Personen** (den Entwickler selbst + bis zu 4 weitere, alle müssen in
der Spotify-App als Testnutzer eingetragen werden) gebaut werden, nicht als
Feature für alle Vibe-Nutzer. Das ist trotzdem für den persönlichen Gebrauch
sinnvoll umsetzbar — sollte aber nicht als "kommendes Feature für alle" beworben
werden, sondern klar als persönliches Extra behandelt werden, es sei denn
Spotify lockert die Regeln wieder.

Die relevanten Endpunkte (`Get Followed Artists`, `Get User's Top Items`)
funktionieren technisch weiterhin auch im eingeschränkten Development Mode.

## Technischer Ansatz (falls umgesetzt)
1. **Auth**: Authorization Code Flow **mit PKCE** — kein Client Secret nötig,
   passt zu einer reinen Web-App/PWA ohne eigenes Backend (Secret könnte im
   Client-Code sowieso nicht sicher versteckt werden). Nur die `Client ID`
   muss im Frontend hinterlegt werden (öffentlich sichtbar, das ist bei PKCE
   so vorgesehen).
2. Spotify Developer Dashboard: neue App anlegen, Redirect-URI auf die
   deployte PWA-URL setzen (z.B. `https://<username>.github.io/Vibe/spotify-callback`),
   Scopes: `user-follow-read` (gefolgte Künstler) und/oder
   `user-top-read` (meistgehörte Künstler).
3. Nach Login: `GET /me/following?type=artist` bzw.
   `GET /me/top/artists` abrufen, Künstlernamen extrahieren.
4. **Matching gegen `events`**: Künstlernamen fuzzy gegen `events.title`
   (und ggf. `organizer`) abgleichen — ähnliches Problem wie die
   Venue-Kanonisierung in `collectors/core/known_venues.ts` bzw.
   `canonicalizeVenue()` in `app/app/index.tsx`, nur für Künstlernamen statt
   Venues. Exaktes 1:1-Matching wird viele Treffer verpassen (Künstler
   erscheinen im Event-Titel oft mit Zusätzen wie "& Band", "presents",
   Tour-Namen etc.) — eine einfache "enthält den Künstlernamen als Teilstring
   (case-insensitive)"-Heuristik ist ein pragmatischer erster Schritt.
5. Bei Treffer: automatisch einen Eintrag in der `favorites`-Tabelle anlegen
   (gleiche Tabelle/Pipeline wie im manuellen Favoriten-Feature, siehe
   Haupt-Plan) — nutzt damit dieselbe Erinnerungs-Logik (Notifier-Cron aus
   Phase 4) ohne zusätzliche Infrastruktur.
6. Access-Token-Refresh: Spotify-Access-Tokens laufen nach 1h ab, Refresh-Token
   muss sicher genug im Client gespeichert werden (z.B. gleicher
   AsyncStorage-Mechanismus wie die Device-ID aus dem Favoriten-Plan).

## Abhängigkeit vom Favoriten-Feature
Baut sinnvollerweise auf der `favorites`-Tabelle und dem Notifier-Cron aus dem
Haupt-Feature-Plan auf (device_id-basierte Favoriten + wöchentliche/monatliche
Erinnerungen) — sollte also erst nach Phase 2-4 dieses Plans angegangen werden,
nicht davor.

## Offene Entscheidungen für den Nutzer
- Ist eine auf ~5 Personen begrenzte Nutzung akzeptabel, oder lohnt sich der
  Aufwand nicht, solange Spotify keine öffentliche Freigabe erlaubt?
- Hat der Nutzer (als Entwickler-Account) Spotify Premium? Ohne Premium ist
  aktuell laut obiger Recherche gar keine neue Development-Mode-Integration
  möglich.
- Reicht "gefolgte Künstler" (`user-follow-read`) oder ist "meistgehörte
  Künstler" (`user-top-read`, auch ohne explizites Folgen) das eigentlich
  gewünschte Signal? Beide sind technisch kombinierbar.
