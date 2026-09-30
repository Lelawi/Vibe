-- Protokoll pro Collector-Lauf und Quelle (geschrieben von
-- collectors/collect-all.ts). Vorher gab es kein verlässliches Signal, ob
-- eine Quelle noch liefert: collect-all fing alle Fehler ab, 0 Events sahen
-- wie Erfolg aus, und source_checked_at wurde von Dedup mitgesetzt — so
-- blieben milla/meinestadt/eventbrite/bahnwaerter-thiel wochenlang
-- unbemerkt leer (Fund 2026-09-30). Grundlage für den Abschnitt
-- "Quellen ohne Daten" im Wochenbericht.
create table if not exists collector_runs (
  id bigint generated always as identity primary key,
  run_started_at timestamptz not null,
  source text not null,
  rows_written integer,
  duration_seconds integer,
  error text,
  seasonal boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists collector_runs_source_run_idx on collector_runs (source, run_started_at desc);

-- Nur service_role (Collector) schreibt/liest; keine Policies für anon.
alter table collector_runs enable row level security;
