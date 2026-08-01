import { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Platform, SafeAreaView, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { registerStrings, useTranslation } from '../lib/strings';

registerStrings({
  'onboarding.title': { de: 'Wonach ist dir?', en: 'What are you into?' },
  'onboarding.subtitle': {
    de: 'Such dir aus, was dich reizt. Mehrfach geht auch.',
    en: 'Pick what interests you. Multiple selections are fine.',
  },
  'onboarding.nearbyTitle': { de: 'In deiner Nähe zuerst', en: 'Nearby first' },
  'onboarding.nearbyOn': { de: 'Standort bleibt auf dem Gerät', en: 'Location stays on your device' },
  'onboarding.nearbyOff': { de: 'Aus — Liste bleibt chronologisch', en: 'Off — list stays chronological' },
  'onboarding.ctaEmpty': { de: 'Zeig mir alles', en: 'Show me everything' },
  'onboarding.ctaSelected': { de: 'Weiter mit', en: 'Continue with' },
});

// Kategorien + Icons 1:1 aus dem Claude-Design-Handoff ("Lelawi Vibe
// First-Run Redesign", HANDOFF.md Runde 2 Todos 8-12) — die dort geplante
// 8-Kacheln-Verfeinerung von Richtung 2b wurde im Design-Canvas nie fertig
// gezeichnet, hier direkt aus der dokumentierten Entscheidung gebaut statt
// aus dem unfertigen 6-Kacheln-Entwurf. Bilder: freie Pexels-Fotos (keine
// Namensnennung nötig), einmalig heruntergeladen und als lokale Assets
// gebündelt statt live nachgeladen — kein Laufzeit-API-Aufruf, keine
// laufenden Kosten (source.unsplash.com, die ursprünglich für sowas
// gedachte Quelle, ist seit 2021 abgeschaltet).
const ONBOARDING_CATEGORIES: { label: string; icon: keyof typeof Ionicons.glyphMap; image: number }[] = [
  { label: 'Konzerte', icon: 'musical-notes-outline', image: require('../assets/onboarding/konzerte.jpg') },
  { label: 'Comedy', icon: 'happy-outline', image: require('../assets/onboarding/comedy.jpg') },
  { label: 'Party & Nachtleben', icon: 'flash-outline', image: require('../assets/onboarding/party.jpg') },
  { label: 'Märkte', icon: 'basket-outline', image: require('../assets/onboarding/maerkte.jpg') },
  { label: 'Theater & Bühne', icon: 'color-wand-outline', image: require('../assets/onboarding/theater.jpg') },
  { label: 'Ausstellungen', icon: 'image-outline', image: require('../assets/onboarding/ausstellungen.jpg') },
  { label: 'Familie & Kinder', icon: 'people-outline', image: require('../assets/onboarding/familie.jpg') },
  { label: 'Yoga', icon: 'leaf-outline', image: require('../assets/onboarding/yoga.jpg') },
];

export default function OnboardingScreen({ onComplete }: { onComplete: (categories: string[], nearby: boolean) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [nearby, setNearby] = useState(false);

  function toggleCategory(label: string) {
    setSelected((prev) => (prev.includes(label) ? prev.filter((v) => v !== label) : [...prev, label]));
  }

  const ctaLabel =
    selected.length > 0 ? `${t('onboarding.ctaSelected')} ${selected.length}` : t('onboarding.ctaEmpty');

  return (
    <SafeAreaView style={styles.wrap}>
      <View style={styles.content}>
        <Text style={styles.title}>{t('onboarding.title')}</Text>
        <Text style={styles.subtitle}>{t('onboarding.subtitle')}</Text>

        <View style={styles.grid}>
          {ONBOARDING_CATEGORIES.map((cat) => {
            const on = selected.includes(cat.label);
            return (
              <TouchableOpacity
                key={cat.label}
                style={[styles.tile, on && styles.tileActive]}
                onPress={() => toggleCategory(cat.label)}
                activeOpacity={0.8}
              >
                <Image source={cat.image} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                <LinearGradient
                  colors={on ? ['rgba(0,170,255,0.12)', 'rgba(0,0,0,0.75)'] : ['rgba(0,0,0,0.1)', 'rgba(0,0,0,0.8)']}
                  style={StyleSheet.absoluteFillObject}
                />
                <View style={styles.tileMark}>
                  <Ionicons name={on ? 'checkmark-circle' : 'add-circle-outline'} size={20} color={on ? '#0af' : '#fff'} />
                </View>
                <View style={styles.tileLabelRow}>
                  <Ionicons name={cat.icon} size={16} color={on ? '#0af' : '#fff'} />
                  <Text style={[styles.tileLabel, on && styles.tileLabelActive]}>{cat.label}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.spacer} />

        <TouchableOpacity
          style={[styles.nearbyRow, nearby && styles.nearbyRowActive]}
          onPress={() => setNearby((v) => !v)}
          activeOpacity={0.8}
        >
          <Ionicons name="location-outline" size={20} color={nearby ? '#0af' : '#888'} />
          <View style={styles.nearbyTextWrap}>
            <Text style={styles.nearbyTitle}>{t('onboarding.nearbyTitle')}</Text>
            <Text style={styles.nearbySub}>{nearby ? t('onboarding.nearbyOn') : t('onboarding.nearbyOff')}</Text>
          </View>
          <Ionicons name={nearby ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={nearby ? '#0af' : '#888'} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.cta} onPress={() => onComplete(selected, nearby)} activeOpacity={0.85}>
          <Text style={styles.ctaText}>{ctaLabel}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000' },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'web' ? 40 : 12, paddingBottom: 24 },
  title: { fontSize: 34, fontWeight: '800', color: '#fff', letterSpacing: -0.4, lineHeight: 38 },
  subtitle: { fontSize: 15, color: '#999', marginTop: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20 },
  tile: {
    width: '48.5%',
    height: 108,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#161616',
    justifyContent: 'flex-end',
  },
  tileActive: { borderColor: '#0af' },
  tileMark: { position: 'absolute', right: 10, top: 10 },
  tileLabelRow: { position: 'absolute', left: 12, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  tileLabel: { fontSize: 14, fontWeight: '700', color: '#fff' },
  tileLabelActive: { color: '#0af' },
  spacer: { flex: 1, minHeight: 24 },
  nearbyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
  },
  nearbyRowActive: { borderColor: 'rgba(0,170,255,0.55)' },
  nearbyTextWrap: { flex: 1 },
  nearbyTitle: { fontSize: 14, fontWeight: '700', color: '#fff' },
  nearbySub: { fontSize: 12, color: '#888', marginTop: 2 },
  cta: {
    backgroundColor: '#0af',
    borderRadius: 30,
    padding: 17,
    alignItems: 'center',
    shadowColor: '#0af',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  ctaText: { fontSize: 16, fontWeight: '800', color: '#000' },
});
