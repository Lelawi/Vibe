import { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  SafeAreaView,
  Linking,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { isOpenNow, todayLabel } from '../lib/openingHours';
import { fuzzyMatch } from '../lib/fuzzySearch';
import { distanceKm, formatDistance } from '../lib/geo';

type Bar = {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  website: string | null;
  phone: string | null;
};

type NearbyEvent = {
  id: string;
  title: string;
  location_name: string | null;
  start_date: string;
  start_time: string | null;
};

const OPEN_PRIORITY: Record<'open' | 'unknown' | 'closed', number> = { open: 0, unknown: 1, closed: 2 };

function openState(open: boolean | null): 'open' | 'unknown' | 'closed' {
  return open === true ? 'open' : open === false ? 'closed' : 'unknown';
}

export default function BarsScreen() {
  const router = useRouter();
  const [bars, setBars] = useState<Bar[]>([]);
  const [nearbyEvents, setNearbyEvents] = useState<NearbyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied'>('idle');
  const [closedReports, setClosedReports] = useState<Set<string>>(new Set());

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function toggleNearby() {
    if (userLocation) {
      setUserLocation(null);
      setLocationStatus('idle');
      return;
    }
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('denied');
      return;
    }
    setLocationStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocationStatus('idle');
      },
      () => setLocationStatus('denied'),
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().slice(0, 10);
      // Nur die nächsten 2 Tage statt aller künftigen Events laden: der
      // Anwendungsfall ist "was ist JETZT/heute Abend los", nicht
      // Wochen-Planung — hält diese eigene Abfrage klein und unabhängig von
      // der (viel größeren, paginierten) Hauptliste.
      const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const [barsRes, eventsRes, reportsRes] = await Promise.all([
        supabase
          .from('bars')
          .select('id,name,address,latitude,longitude,opening_hours_raw,website,phone')
          .order('name', { ascending: true }),
        supabase
          .from('events')
          .select('id,title,location_name,start_date,start_time')
          .gte('start_date', today)
          .lte('start_date', soon)
          .is('duplicate_of', null)
          .not('location_name', 'is', null)
          .limit(1000),
        supabase.from('bar_closure_reports').select('bar_id'),
      ]);
      setBars(barsRes.data ?? []);
      setNearbyEvents(eventsRes.data ?? []);
      setClosedReports(new Set((reportsRes.data ?? []).map((r) => r.bar_id as string)));
      setLoading(false);
    }
    load();
  }, []);

  // Keine automatisierte Möglichkeit zu erkennen, ob eine OSM-gepflegte Bar
  // tatsächlich noch existiert — stattdessen können Nutzer:innen das direkt
  // melden. Optimistisches Ausblenden, damit es sich sofort "erledigt"
  // anfühlt; schlägt der Insert fehl, kommt die Bar beim nächsten Laden
  // einfach wieder.
  async function reportClosed(barId: string, barName: string) {
    setClosedReports((prev) => new Set(prev).add(barId));
    const { error } = await supabase
      .from('bar_closure_reports')
      .upsert({ bar_id: barId }, { onConflict: 'bar_id' });
    if (error && Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(`Melden von "${barName}" ist fehlgeschlagen.`);
    } else if (error) {
      Alert.alert('Fehler', `Melden von "${barName}" ist fehlgeschlagen.`);
    }
  }

  // Programm der nächsten 2 Tage einer Bar zuordnen — über dieselbe
  // Venue-Kanonisierung, die auch der Location-Filter der Hauptliste nutzt
  // (app/lib/venue.ts), da OSM-Bar-Namen und die Location-Schreibweise der
  // Event-Quellen selten exakt übereinstimmen ("Wintergarten" vs.
  // "Wintergarten am Elisabethmarkt").
  const eventsByVenue = useMemo(() => {
    const map = new Map<string, NearbyEvent[]>();
    for (const e of nearbyEvents) {
      const key = canonicalizeVenue(e.location_name);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [nearbyEvents]);

  const enrichedBars = useMemo(() => {
    const now = new Date();
    return bars
      .filter((bar) => !closedReports.has(bar.id))
      .map((bar) => ({
        ...bar,
        open: isOpenNow(bar.opening_hours_raw, now),
        hoursToday: todayLabel(bar.opening_hours_raw, now),
        program: eventsByVenue.get(canonicalizeVenue(bar.name)) ?? [],
        distanceKm:
          userLocation && bar.latitude != null && bar.longitude != null
            ? distanceKm(userLocation.lat, userLocation.lng, bar.latitude, bar.longitude)
            : null,
      }));
  }, [bars, eventsByVenue, userLocation, closedReports]);

  const filteredBars = useMemo(() => {
    return enrichedBars
      .filter((b) => fuzzyMatch([b.name, b.address].filter(Boolean).join(' '), search))
      .sort((a, b) => {
        // Bei aktiver Nähe-Suche zählt nur die Entfernung — der eigentliche
        // Zweck ist "was ist gleich um die Ecke", eine offene Bar 3km weiter
        // weg soll eine geschlossene direkt nebenan nicht überstimmen.
        if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
        const priorityDiff = OPEN_PRIORITY[openState(a.open)] - OPEN_PRIORITY[openState(b.open)];
        if (priorityDiff !== 0) return priorityDiff;
        return a.name.localeCompare(b.name, 'de');
      });
  }, [enrichedBars, search]);

  const openCount = useMemo(() => filteredBars.filter((b) => b.open === true).length, [filteredBars]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <TouchableOpacity style={styles.backBar} onPress={goBack}>
          <Text style={styles.backBarText}>‹ Übersicht</Text>
        </TouchableOpacity>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.backBar} onPress={goBack}>
        <Text style={styles.backBarText}>‹ Übersicht</Text>
      </TouchableOpacity>

      <View style={styles.headerBlock}>
        <View style={styles.headerTitleRow}>
          <View>
            <Text style={styles.title}>Bars</Text>
            <Text style={styles.subtitle}>
              {openCount} von {filteredBars.length} gerade geöffnet
            </Text>
          </View>
          <TouchableOpacity style={styles.mapButton} onPress={() => router.push('/bars-map')}>
            <Ionicons name="map-outline" size={15} color="#fff" />
            <Text style={styles.mapButtonText}>Karte</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.toolRow}>
        <TextInput
          style={styles.search}
          placeholder="Bar oder Adresse suchen..."
          placeholderTextColor="#666"
          value={search}
          onChangeText={setSearch}
        />
        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={[styles.nearbyButton, userLocation && styles.nearbyButtonActive]}
            onPress={toggleNearby}
            disabled={locationStatus === 'loading'}
          >
            {locationStatus === 'loading' ? (
              <ActivityIndicator size="small" color="#999" />
            ) : (
              <Ionicons name="location-outline" size={16} color={userLocation ? '#000' : '#999'} />
            )}
            <Text style={[styles.nearbyButtonText, userLocation && styles.nearbyButtonTextActive]}>
              {locationStatus === 'loading' ? 'Lädt…' : 'Nähe'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filteredBars}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.empty}>Keine Bars gefunden.</Text>}
        renderItem={({ item }) => {
          const hasCoords = item.latitude != null && item.longitude != null;
          return (
            <TouchableOpacity
              style={styles.card}
              disabled={!hasCoords}
              onPress={() =>
                router.push({
                  pathname: '/bars-map',
                  params: { id: item.id, lat: String(item.latitude), lng: String(item.longitude) },
                })
              }
            >
              <View style={styles.cardHeaderRow}>
                <Text style={styles.barName}>{item.name}</Text>
                {item.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                {item.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
              </View>
              {(item.address || item.distanceKm != null) && (
                <Text style={styles.barAddress}>
                  {item.address}
                  {item.address && item.distanceKm != null ? ' · ' : ''}
                  {item.distanceKm != null ? formatDistance(item.distanceKm) : ''}
                </Text>
              )}
              {item.hoursToday ? (
                <Text style={styles.barHours}>Heute: {item.hoursToday}</Text>
              ) : item.opening_hours_raw ? (
                <Text style={styles.barHours}>{item.opening_hours_raw}</Text>
              ) : (
                <Text style={styles.barHoursUnknown}>Öffnungszeiten unbekannt</Text>
              )}
              {item.program.length > 0 && (
                <View style={styles.programWrap}>
                  {item.program.map((ev) => (
                    <TouchableOpacity
                      key={ev.id}
                      onPress={(e) => {
                        e.stopPropagation();
                        router.push(`/event/${ev.id}`);
                      }}
                    >
                      <Text style={styles.programText}>
                        🎤 {ev.title}
                        {ev.start_time ? ` · ${ev.start_time.slice(0, 5)}` : ''}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={styles.cardFooterRow}>
                {item.website && (
                  <TouchableOpacity
                    onPress={(e) => {
                      e.stopPropagation();
                      Linking.openURL(item.website!);
                    }}
                  >
                    <Text style={styles.websiteLink}>Website öffnen</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={(e) => {
                    e.stopPropagation();
                    reportClosed(item.id, item.name);
                  }}
                >
                  <Text style={styles.reportLink}>Gibt's nicht mehr?</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  backBar: { paddingHorizontal: 16, paddingVertical: 12 },
  backBarText: { color: '#0af', fontSize: 15, fontWeight: '600' },
  headerBlock: { paddingHorizontal: 16, marginBottom: 12 },
  headerTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#888', fontSize: 13, marginTop: 2 },
  mapButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  mapButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  toolRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12, alignItems: 'center' },
  search: {
    flex: 1,
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 15,
  },
  nearbyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  nearbyButtonActive: { backgroundColor: '#0af' },
  nearbyButtonText: { color: '#999', fontSize: 14, fontWeight: '600' },
  nearbyButtonTextActive: { color: '#000' },
  listContent: { paddingHorizontal: 16, paddingBottom: 40 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40 },
  card: {
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    marginBottom: 10,
  },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barName: { color: '#fff', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  openBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4ade80',
    backgroundColor: '#4ade8022',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  closedBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ff6b6b',
    backgroundColor: '#ff6b6b22',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  barAddress: { color: '#999', fontSize: 13, marginTop: 4 },
  barHours: { color: '#999', fontSize: 13, marginTop: 4 },
  barHoursUnknown: { color: '#555', fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  programWrap: { marginTop: 8, gap: 4 },
  programText: { color: '#5fd4ff', fontSize: 13 },
  cardFooterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  websiteLink: { color: '#0af', fontSize: 13 },
  reportLink: { color: '#555', fontSize: 12 },
});
