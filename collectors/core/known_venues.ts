// Canonical venue name map for München locations.
// Use lowercase keys for matching incoming venue strings.
export const KNOWN_VENUES: Record<string, string> = {
  'muffathalle': 'Muffathalle München',
  'muffatwerk': 'Muffathalle München',
  'zenith münchen': 'Zenith München',
  'backstage halle': 'Backstage München',
  'backstage club': 'Backstage München',
  'backstage': 'Backstage München',
  'gasteig': 'Gasteig München',
  'kulturzentrum gasteig': 'Gasteig München',
  'münchner kammerspiele': 'Münchner Kammerspiele',
  'kammerspiele': 'Münchner Kammerspiele',
  'pasinger fabrik': 'Pasinger Fabrik',
  'pasing fabrik': 'Pasinger Fabrik',
  'glyptothek': 'Glyptothek München',
  'freie theater': 'Freies Theater München',
  'forum am deutschen theater': 'Forum am Deutschen Theater',
  'schlachthof': 'Gasteig HP8 / Schlachthof',
  'gasteig hp8': 'Gasteig HP8 / Schlachthof',
  'kultfabrik': 'Kultfabrik/Optimolwerke',
  'optimolwerke': 'Kultfabrik/Optimolwerke',
  'backstage arena': 'Backstage München',
  'milla club': 'Milla Club',
  'technikum': 'Technikum München',
  'tonhalle': 'TonHalle München',
  'glockenbachwerkstatt': 'Glockenbachwerkstatt',
  'halle 2': 'Halle 2',
  'freie universitÄt': 'Freie Universität (München)',
  'kreativquartier': 'Kreativquartier München',
  'haus der kunst': 'Haus der Kunst',
  'alte kongresshalle': 'Alte Kongresshalle',
  'stadtmuseum': 'Stadtmuseum München',
  'milla club': 'Milla Club',
  'ampere': 'AMPERE München',
  'kubiz': 'Kubiz München',
  'backstage werke': 'Backstage München',
  'kongress am park': 'Kongress am Park',
  'kulturbahnhof': 'Kulturbahnhof',
  'backstage arena süd': 'Backstage München',
  'backstage arena süd open air': 'Backstage München',
  'backstage biergarten': 'Backstage München',
  'backyard open air': 'Backstage München',
  'zenithhalle': 'Zenith München',
  'zenith munich': 'Zenith München',
  'muffat werk': 'Muffathalle München',
  'milla münchen': 'Milla Club',
  'p1 club': 'P1',
  'import export': 'Import Export München',
  'import/export': 'Import Export München',
  'olympi export': 'Import Export München',
  'impex': 'Import Export München',
  'olympiapark münchen': 'Olympiapark München',
  'olympia park': 'Olympiapark München',
  'brunnenhof': 'Brunnenhof',
  'deutsches theater silbersaal': 'Deutsches Theater München',
  'deutsches theater theatersaal': 'Deutsches Theater München',
  // Migrated from app OVERRIDES
  'hotel bayerischer hof, festsaal': 'Hotel Bayerischer Hof',
  'hotel bayerischer hof, night': 'Hotel Bayerischer Hof',
  'residenz, brunnenhof': 'Brunnenhof',
  'residenz, brunnenhof/herkulessaal': 'Brunnenhof',
  'brunnenhof der residenz': 'Brunnenhof',
  'backstage all area': 'Backstage München',
  'schloss blutenburg, jella': 'Schloss Blutenburg',
  'schloss blutenburg, unterer schlosshof': 'Schloss Blutenburg',
  'schloss blutenburg': 'Schloss Blutenburg',
};

export function getCanonicalVenue(name?: string | null): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  // Exact match first
  if (KNOWN_VENUES[key]) return KNOWN_VENUES[key];

  // Pattern-based matching for flexible variants
  const PATTERN_VENUES: { pattern: RegExp; canonical: string }[] = [
    { pattern: /\bbackstage\b|backyard/i, canonical: 'Backstage München' },
    { pattern: /muffat/i, canonical: 'Muffathalle München' },
    { pattern: /zenith/i, canonical: 'Zenith München' },
    { pattern: /milla/i, canonical: 'Milla Club' },
    { pattern: /\bp\s*1\b|\bp1\b/i, canonical: 'P1' },
    { pattern: /olympia\s*park|olympiapark/i, canonical: 'Olympiapark München' },
    { pattern: /brunnenhof/i, canonical: 'Brunnenhof' },
    { pattern: /ampere/i, canonical: 'AMPERE München' },
    { pattern: /gasteig/i, canonical: 'Gasteig München' },
    { pattern: /kammerspiele/i, canonical: 'Münchner Kammerspiele' },
    { pattern: /pasinger fabr/i, canonical: 'Pasinger Fabrik' },
  ];

  for (const p of PATTERN_VENUES) {
    if (p.pattern.test(name)) return p.canonical;
  }

  return null;
}

// Optional: known addresses for venues to improve geocoding accuracy.
export const KNOWN_VENUE_ADDRESSES: Record<string, string> = {
  'backstage münchen': 'Reitknechtstr. 6, 80639 München',
  'muffathalle münchen': 'Zellstr. 4, 81667 München',
  'zenith münchen': 'Lilienthalallee 29, 80939 München',
  'gasteig münchen': 'Rosenheimer Str. 5, 81667 München',
  'münchner kammerspiele': 'Maximilianstr. 1, 80539 München',
  'pasinger fabrik': 'Helfensteinstr. 35, 81241 München',
  'milla club': 'Hirschgartenallee 1, 80639 München',
  'ampere münchen': 'Zenettistr. 9, 81679 München',
  'kubiz münchen': 'Seidlstr. 10, 80335 München',
};

export function getVenueAddress(canonicalOrName?: string | null): string | null {
  if (!canonicalOrName) return null;
  const key = canonicalOrName.trim().toLowerCase();
  return KNOWN_VENUE_ADDRESSES[key] ?? null;
}
