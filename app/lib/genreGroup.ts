const GENRE_GROUPS: { label: string; patterns: RegExp[] }[] = [
  { label: 'Pop & Rock', patterns: [/pop/i, /rock/i, /alternative/i, /indie/i, /singer/i, /schlager/i] },
  { label: 'Electronic', patterns: [/house/i, /techno/i, /trance/i, /electro/i, /dance/i, /rave/i, /dnb/i, /drum & bass/i, /deep house/i, /tech-house/i, /dj/i] },
  { label: 'Metal & Punk', patterns: [/metal/i, /punk/i, /hardcore/i, /screamo/i, /death metal/i, /black metal/i, /thrash/i] },
  { label: 'Hip-Hop & Rap', patterns: [/hip[-\s]?hop/i, /rap/i, /trap/i] },
  { label: 'Soul, Funk & Disco', patterns: [/soul/i, /funk/i, /disco/i, /r&b/i, /rnb/i] },
  { label: 'Jazz & Blues', patterns: [/jazz/i, /blues/i, /swing/i] },
  { label: 'Klassik & Chor', patterns: [/klassik/i, /chor/i, /orchester/i, /oper/i, /ballett/i] },
  { label: 'Party & Club', patterns: [/club/i, /party/i, /aftershow/i, /dancefloor/i] },
  { label: 'Comedy & Show', patterns: [/comedy/i, /kabarett/i, /show/i, /stand[-\s]?up/i] },
  { label: 'Markt, Bildung & Familie', patterns: [/markt/i, /flohmarkt/i, /dult/i, /bildung/i, /workshop/i, /yoga/i, /family/i, /kids/i, /community/i] },
];

export function normalizeGenreGroup(value: string | null | undefined): string {
  const source = value?.trim();
  if (!source) return 'Sonstiges';
  const match = GENRE_GROUPS.find((group) =>
    group.patterns.some((pattern) => pattern.test(source.toLowerCase()))
  );
  return match ? match.label : 'Sonstiges';
}
