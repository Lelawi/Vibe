export function normalizeArtistName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type StructuredArtistLink = { sourceId: string; names: string[] };

// Künstler werden nur aus Quellen verknüpft, die einen konkreten Programmslot
// liefern. Aus Beschreibungs-Freitext wird bewusst nichts geraten.
export async function linkStructuredArtists(
  supabase: any,
  links: StructuredArtistLink[],
  source: string
): Promise<void> {
  const names = [...new Set(links.flatMap((link) => link.names.map((name) => name.trim())).filter(Boolean))];
  const artistRows = [...new Map(names
    .map((name) => ({ display_name: name, normalized_name: normalizeArtistName(name) }))
    .filter((row) => row.normalized_name.length >= 2)
    .map((row) => [row.normalized_name, row] as const)).values()];
  if (artistRows.length === 0) return;

  const { error: artistUpsertError } = await supabase
    .from('artists')
    .upsert(artistRows, { onConflict: 'normalized_name' });
  if (artistUpsertError) throw artistUpsertError;

  const normalizedNames = [...new Set(artistRows.map((row) => row.normalized_name))];
  const sourceIds = [...new Set(links.map((link) => link.sourceId))];
  const [{ data: artists, error: artistError }, { data: events, error: eventError }] = await Promise.all([
    supabase.from('artists').select('id,normalized_name').in('normalized_name', normalizedNames),
    supabase.from('events').select('id,source_id').in('source_id', sourceIds),
  ]);
  if (artistError) throw artistError;
  if (eventError) throw eventError;

  const artistIds = new Map((artists ?? []).map((artist) => [artist.normalized_name as string, artist.id as string]));
  const eventIds = new Map((events ?? []).map((event) => [event.source_id as string, event.id as string]));
  const relationKeys = new Set<string>();
  const relations = links.flatMap((link) => {
    const eventId = eventIds.get(link.sourceId);
    if (!eventId) return [];
    return link.names.flatMap((name) => {
      const artistId = artistIds.get(normalizeArtistName(name));
      const key = artistId ? `${eventId}:${artistId}` : '';
      if (!artistId || relationKeys.has(key)) return [];
      relationKeys.add(key);
      return [{ event_id: eventId, artist_id: artistId, source, confidence: 'structured' }];
    });
  });
  if (relations.length === 0) return;
  const { error: relationError } = await supabase
    .from('event_artists')
    .upsert(relations, { onConflict: 'event_id,artist_id' });
  if (relationError) throw relationError;
}
