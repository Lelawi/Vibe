import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useFollowedArtists } from '../../lib/followedArtists';
import { isPushEnabled, syncArtistFollowsToServer } from '../../lib/pushNotifications';

type Artist = { id: string; display_name: string };
type ArtistEvent = {
  id: string;
  title: string;
  start_date: string;
  start_time: string | null;
  location_name: string | null;
  sold_out: boolean | null;
};

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function ArtistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [artist, setArtist] = useState<Artist | null>(null);
  const [events, setEvents] = useState<ArtistEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const { followedArtists, isFollowingArtist, toggleArtist } = useFollowedArtists();

  useEffect(() => {
    async function load() {
      const { data: artistData, error: artistError } = await supabase
        .from('artists').select('id,display_name').eq('id', id).single();
      if (artistError || !artistData) { setLoading(false); return; }
      setArtist(artistData as Artist);
      const { data: links } = await supabase.from('event_artists').select('event_id').eq('artist_id', id);
      const eventIds = (links ?? []).map((link) => link.event_id as string);
      if (eventIds.length > 0) {
        const current = today();
        const { data } = await supabase
          .from('events')
          .select('id,title,start_date,start_time,end_date,location_name,sold_out')
          .in('id', eventIds)
          .is('duplicate_of', null)
          .or(`start_date.gte.${current},end_date.gte.${current}`)
          .order('start_date', { ascending: true });
        setEvents((data ?? []) as ArtistEvent[]);
      }
      setLoading(false);
    }
    if (id) load();
  }, [id]);

  useEffect(() => {
    isPushEnabled().then((enabled) => {
      if (enabled) syncArtistFollowsToServer(followedArtists);
    });
  }, [followedArtists]);

  const goBack = () => router.canGoBack() ? router.back() : router.replace('/');
  if (loading) return <SafeAreaView style={styles.center}><ActivityIndicator color="#0af" size="large" /></SafeAreaView>;
  if (!artist) return <SafeAreaView style={styles.center}><Text style={styles.empty}>Künstler nicht gefunden.</Text></SafeAreaView>;
  const following = isFollowingArtist(artist.id);

  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={goBack}><Text style={styles.backText}>‹ Übersicht</Text></TouchableOpacity>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Ionicons name="musical-notes" size={34} color="#0af" />
          <Text style={styles.title}>{artist.display_name}</Text>
          <TouchableOpacity
            style={[styles.followButton, following && styles.followButtonActive]}
            onPress={() => toggleArtist({ id: artist.id, name: artist.display_name })}
          >
            <Ionicons name={following ? 'notifications' : 'notifications-outline'} size={16} color={following ? '#000' : '#0af'} />
            <Text style={[styles.followText, following && styles.followTextActive]}>{following ? 'Gefolgt' : 'Folgen'}</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.heading}>Kommende Events</Text>
        {events.length === 0 ? <Text style={styles.empty}>Aktuell sind keine weiteren Termine bekannt.</Text> : events.map((event) => (
          <TouchableOpacity key={event.id} style={styles.card} onPress={() => router.push(`/event/${event.id}`)}>
            <View style={styles.cardBody}>
              <Text style={styles.eventTitle}>{event.title}</Text>
              <Text style={styles.meta}>
                {new Date(`${event.start_date}T00:00`).toLocaleDateString('de-DE')}
                {event.start_time ? ` · ${event.start_time.slice(0, 5)} Uhr` : ''}
                {event.location_name ? ` · ${event.location_name}` : ''}
              </Text>
            </View>
            {event.sold_out && <Text style={styles.soldOut}>Ausverkauft</Text>}
            <Ionicons name="chevron-forward" size={18} color="#666" />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  back: { paddingHorizontal: 16, paddingVertical: 14 },
  backText: { color: '#0af', fontSize: 15, fontWeight: '600' },
  content: { padding: 16, paddingBottom: 60 },
  hero: { backgroundColor: '#141414', borderRadius: 18, alignItems: 'center', padding: 26, gap: 12, marginBottom: 26 },
  title: { color: '#fff', fontSize: 27, fontWeight: '800', textAlign: 'center' },
  followButton: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: '#0af', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  followButtonActive: { backgroundColor: '#0af' },
  followText: { color: '#0af', fontWeight: '700' },
  followTextActive: { color: '#000' },
  heading: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#141414', borderRadius: 12, padding: 14, marginBottom: 10, gap: 8 },
  cardBody: { flex: 1 },
  eventTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  meta: { color: '#999', fontSize: 12, marginTop: 5, lineHeight: 17 },
  soldOut: { color: '#ff6b6b', fontSize: 11, fontWeight: '700' },
  empty: { color: '#777', lineHeight: 20 },
});
