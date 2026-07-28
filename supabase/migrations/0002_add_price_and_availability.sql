-- Preis- und Verfügbarkeitsinformationen für Events. Freitext statt fixer
-- Zahl+Währung, da Quellen sehr unterschiedliche Formate liefern
-- ("VVK 20€ / AK 25€", "ab 12€", "kostenfrei") — eine strukturierte Zahl
-- würde bei den meisten Quellen ohnehin nur grob geraten werden können.
alter table events add column if not exists price_info text;
alter table events add column if not exists sold_out boolean;

comment on column events.price_info is 'Freitext-Preisangabe der Quelle, z.B. "VVK 20€ / AK 25€" oder "kostenfrei". NULL = keine Information verfügbar (nicht: kostenlos).';
comment on column events.sold_out is 'true = laut Quelle ausverkauft, false = laut Quelle noch verfügbar, NULL = keine Information.';
