-- "Veranstalter folgen" (nach dem Vorbild von Bandsintown/DICE: Erinnerung
-- bekommen, sobald ein bestimmter Veranstalter/Künstler ein neues Event
-- bekommt) als dritte Filter-Dimension neben categories/locations. Eigene
-- Spalte statt eigener Tabelle, da sie exakt wie categories/locations
-- funktioniert (Array pro Subscription, vom Sender bei jedem Lauf gegen neue
-- Events abgeglichen) — siehe collectors/notifications/index.ts.
alter table push_filters add column if not exists organizers text[] not null default '{}';
