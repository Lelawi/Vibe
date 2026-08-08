# Duplicate-Audit Cloud-Routine — Anleitung

Diese Datei ist die vollständige Anleitung für die wöchentliche Cloud-Routine
"Vibe - Duplicate-Audit (Venue-Aliase)". Der Routine-Prompt selbst verweist
hierher, um die Trigger-Konfiguration kurz zu halten.

## Ziel

Systematisch Fast-Duplikate in der `events`-Tabelle finden (ähnlicher
Venue-Name, oder gleicher Ort/gleiche Zeit mit anderem Titel), statt sich nur
auf per Nutzer-Screenshot gemeldete Einzelfälle zu verlassen.

## Ablauf

1. Lies zuerst zum Kontext: `collectors/scripts/duplicate-audit.ts` (das
   Analyse-Tool selbst), `collectors/core/known_venues.ts`,
   `supabase/migrations/0040_venue_aliases_and_backfill.sql`
   (`dedup_known_venue`-Funktion + gruppenweites Nachfüllen).

2. **Zugriffsrechte:** du hast nur `SUPABASE_URL` und `SUPABASE_ANON_KEY`
   (kein `service_role` key — suche auch nicht danach). Das reicht aus: die
   `events`-Tabelle hat eine öffentliche anon-SELECT-Policy (die App liest
   read-only darüber), `duplicate-audit.ts` macht ausschließlich
   SELECT-Abfragen und schreibt nichts. Führe es so aus:

   ```
   cd Vibe/collectors
   npm install
   SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_ANON_KEY" SUPABASE_URL="$SUPABASE_URL" npm run duplicate-audit
   ```

   (Der Variablenname im Skript heißt nur historisch `SERVICE_ROLE_KEY` —
   hier wird bewusst der anon key hineingereicht.)

3. Das Skript gibt zwei Kategorien aus:
   - **Kategorie A "Near-Miss Venue"** (venueSim 0.15–0.4, titleSim > 0.3):
     Alias-Kandidaten — vermutlich derselbe Ort unter leicht
     unterschiedlichem Namen in der DB.
   - **Kategorie B "Gleicher Ort, fremder Titel"** (venueSim > 0.6, titleSim
     < 0.2): strukturell NICHT sicher automatisch zusammenführbar — viele
     davon sind echte, unterschiedliche Events (z.B. Rotationsprogramm
     mehrerer Stücke am selben Abend). Für Kategorie B nur im Report
     auflisten, nichts automatisiert ändern.

4. Für Kategorie-A-Kandidaten:
   a. Prüfe gegen `collectors/core/known_venues.ts` und die SQL-Funktion
      `dedup_known_venue` in der letzten Migration, ob das Paar dort schon
      als Alias erfasst ist. Wenn ja, überspringen.
   b. Wenn neu: bewerte per WebSearch, ob es sich wirklich um denselben
      physischen Ort handelt (zwei Namen für denselben Saal/Komplex) oder um
      zwei eigenständig bespielte, unterschiedliche Venues, die nur ähnlich
      heißen oder zufällig im selben Gebäude liegen (letzteres NICHT
      aliasen — siehe Ampere/Muffatwerk in `known_venues.ts` als
      Negativ-Beispiel: eigenständig bespielte Clubs im selben Gebäude
      werden bewusst nicht aliast).
   c. Nur bei klarer, per Websuche erhärteter Evidenz (offizielle Seite,
      gleiche Adresse, "auch bekannt als" o.ä.) einen Vorschlag vorbereiten:
      - `collectors/core/known_venues.ts` um den neuen Alias-Eintrag
        ergänzen (gleiches Muster wie bestehende Einträge).
      - Neue SQL-Migrationsdatei
        `supabase/migrations/00XX_<kurzer_name>.sql` (nächste freie Nummer)
        anlegen, die `dedup_known_venue()` um denselben Alias ergänzt
        (vollständiger `CREATE OR REPLACE FUNCTION`-Körper wie in 0040, nur
        mit dem zusätzlichen Alias-Paar) und am Ende
        `select public.mark_duplicate_events();` aufruft.
      - `git add` + lokal `git commit` mit klarer Beschreibung der Evidenz.
        **Nicht pushen**, **nicht die Migration selbst ausführen** — keine
        DB-Schreibrechte vorhanden, Migrationen werden grundsätzlich manuell
        vom Projektinhaber über den Supabase SQL-Editor angewendet.
   d. Bei unklarer/schwacher Evidenz: nichts committen, nur im
      Abschlussbericht als offene Frage auflisten.

5. Abschlussbericht: Anzahl Kategorie-A/B-Kandidaten insgesamt, wie viele
   Kategorie-A bereits durch bestehende Aliase abgedeckt sind, für welche
   (falls welche) ein neuer Alias vorbereitet und lokal committet wurde (mit
   Commit-Hash und Evidenz-Begründung), und welche Kandidaten offen zur
   menschlichen Entscheidung bleiben. Kategorie-B nur summarisch nennen
   (Anzahl, auffällige Häufungen), keine Einzelbewertung nötig.

## Sicherheitsprinzip

Ein neuer Venue-Alias, der zwei tatsächlich unabhängige Orte fälschlich
zusammenführt, ist derselbe Fehlertyp wie die frühere free&easy-Dedup-
Regression (`word_similarity`, Migrationen 0035/0036). Lieber einen echten
Alias-Kandidaten für spätere manuelle Prüfung liegen lassen, als einen
falschen vorschlagen.
