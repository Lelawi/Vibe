import type { Language } from './language';

// Anders als bei den Venue-Cuisine-Tags (app/components/VenueListScreen.tsx)
// ist das hier kein festes, geschlossenes Vokabular: die meisten Collector-
// Quellen setzen eine feste Kategorie (siehe collectors/sources/*/index.ts),
// aber eventim (mit Abstand die meisten Events) übernimmt seine
// Top-Level-Kategorie direkt von der eventim-API — dort können jederzeit
// neue Werte auftauchen. Deshalb bewusst kein Title-Case-Fallback wie bei
// cuisineLabel: unbekannte Werte werden einfach unverändert (auf Deutsch)
// angezeigt, statt eine falsche Übersetzung zu raten.
const CATEGORY_LABELS: Record<string, { de: string; en: string }> = {
  Konzerte: { de: 'Konzerte', en: 'Concerts' },
  Comedy: { de: 'Comedy', en: 'Comedy' },
  'Comedy & Kabarett': { de: 'Comedy & Kabarett', en: 'Comedy & Cabaret' },
  Theater: { de: 'Theater', en: 'Theatre' },
  'Theater & Bühne': { de: 'Theater & Bühne', en: 'Theatre & Stage' },
  Kultur: { de: 'Kultur', en: 'Culture' },
  Clubs: { de: 'Clubs', en: 'Clubs' },
  Bars: { de: 'Bars', en: 'Bars' },
  Märkte: { de: 'Märkte', en: 'Markets' },
  Feiern: { de: 'Feiern', en: 'Celebrations' },
  Sonstiges: { de: 'Sonstiges', en: 'Other' },
  Sport: { de: 'Sport', en: 'Sports' },
  'Familie & Kinder': { de: 'Familie & Kinder', en: 'Family & Kids' },
  'Musical & Show': { de: 'Musical & Show', en: 'Musical & Show' },
  'Party & Nachtleben': { de: 'Party & Nachtleben', en: 'Party & Nightlife' },
  'Kleinkunst & Kabarett': { de: 'Kleinkunst & Kabarett', en: 'Cabaret' },
  Ausstellungen: { de: 'Ausstellungen', en: 'Exhibitions' },
  Klassik: { de: 'Klassik', en: 'Classical' },
  Workshops: { de: 'Workshops', en: 'Workshops' },
  Workshop: { de: 'Workshop', en: 'Workshop' },
  Yoga: { de: 'Yoga', en: 'Yoga' },
};

export function categoryLabel(raw: string, language: Language): string {
  return CATEGORY_LABELS[raw]?.[language] ?? raw;
}
