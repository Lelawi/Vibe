# Wöchentliche manuelle Prüfung von Nutzerhinweisen

Alle Hinweise, die nicht zweifelsfrei automatisiert verarbeitet werden
können, landen in einer gemeinsamen, persistenten Prüfliste. Dazu gehören:

- als geschlossen gemeldete Locations,
- Bierpreise und andere falsche oder fehlende Location-Daten,
- falsche Eventdaten,
- fehlende Events oder Locations,
- sonstiges App-Feedback.

Ein offener Eintrag bleibt ohne Zeitlimit in der Liste und erscheint in jedem
Wochenreview erneut, bis eine manuelle Entscheidung getroffen wurde.

## Review erzeugen

```powershell
cd collectors
npm run review-weekly
```

Der Bericht ist schreibgeschützt und zeigt zu jedem Fall eine stabile Kennung,
die Meldung, den aktuellen Datenbankstand und verfügbare Online-Signale. Er
greift ausschließlich direkt auf Supabase zu und verwendet weder Tunnel noch
Netzwerk-Umgehungen.

## Entscheidungsregeln

Für jeden Eintrag gibt es drei Möglichkeiten:

1. **Bestätigen und umsetzen:** Die Daten werden geändert und der Hinweis mit
   einer kurzen Prüfnotiz abgeschlossen.
2. **Ablehnen:** Der Datenstand bleibt unverändert und die Begründung wird in
   der Prüfnotiz dokumentiert.
3. **Offen lassen:** Es wird nichts geändert. Der Fall erscheint im nächsten
   Wochenreview erneut.

Fehlende Online-Belege sind kein Ablehnungsgrund. Insbesondere bei einem lokal
abgelesenen Bierpreis kann die manuelle Entscheidung die maßgebliche Quelle
sein. Ein Google-Nichttreffer beweist ebenfalls keine Schließung; der frühere
Mechanismus mit drei aufeinanderfolgenden Nichttreffern (derselben Quelle, an
verschiedenen Tagen) ist deaktiviert.

Seit der Ergänzung um eine zweite, unabhängige Quelle bestätigt
`precheck-structured-reports.ts` eine Closure-Meldung automatisch (Status
`confirmed`, `analysis_category: venue_closure_heuristic`, Konfidenz 0.75),
wenn **alle drei** zutreffen: kein zuordenbarer Google-Places-Eintrag, keine
oder eine nicht mehr erreichbare hinterlegte Website, und kein
OSM/Nominatim-Treffer für Name+Adresse. Anders als der abgeschaltete
3x-Google-Mechanismus sind das zwei unabhängige Quellen statt derselben Quelle
mehrfach — trotzdem kein Vollbeweis, daher niedrigere Konfidenz als der
eindeutige Google-`CLOSED_PERMANENTLY`-Fall (Konfidenz 1). Solche Fälle
tauchen im Wochenreview nicht mehr auf; bei Verdacht auf einen Fehlgriff
lässt sich der Eintrag jederzeit per `npm run review-closures -- reject
<venue_id> [Notiz]` zurücksetzen.

Für eigene, bereits sicher entschiedene Fälle (z.B. eine selbst gemeldete
Location, die man vor Ort als nicht mehr existent kennt) gibt es außerdem
einen Batch-Weg, der nicht auf den Wochenreview wartet:

```powershell
cd collectors
npm run review-closures -- confirm-batch <venue_id1,venue_id2,...> [Notiz]
npm run review-closures -- reject-batch <venue_id1,venue_id2,...> [Notiz]
```

## Statusmodell

- `event_reports` und `venue_reports`: `pending`, `resolved`, `rejected`
- `venue_closure_reports`: `pending`, `confirmed`, `rejected`
- `app_feedback` und `missing_items`: `new`, `reviewed`

Bei einer Entscheidung setzt die Datenbank automatisch `reviewed_at`. Die
Begründung oder Beschreibung der vorgenommenen Änderung gehört in
`review_note`.

Der Wochenbericht selbst enthält potenziell Nutzereingaben und wird deshalb
nicht als öffentliches GitHub-Actions-Artefakt veröffentlicht. Nach der
automatischen Vorprüfung wird er einmal wöchentlich von der privaten
Claude-Code-Routine vorgelegt. Details stehen in
[`automated-feedback-review.md`](./automated-feedback-review.md).
