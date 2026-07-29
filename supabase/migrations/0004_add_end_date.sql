-- Für Events, die über mehrere Tage laufen (Ausstellungen, Festivals etc.)
-- statt an einem einzelnen Tag stattzufinden. NULL bedeutet "eintägiges
-- Event" (der bisherige Normalfall) — start_date bleibt für die Anzeige des
-- Beginndatums maßgeblich, end_date ist nur bei Mehrtages-Events gesetzt.
alter table events add column if not exists end_date date;
