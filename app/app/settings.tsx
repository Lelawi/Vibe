import { useState, Children, cloneElement, isValidElement } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { registerStrings, useTranslation } from '../lib/strings';
import { usePushEnabled } from '../lib/pushNotifications';
import { useShowFeaturedCarousel } from '../lib/imagePreferences';
import { useReminderSettings } from '../lib/reminderSettings';
import { useSavedSearches } from '../lib/savedSearches';
import { useFollowedOrganizers } from '../lib/followedOrganizers';
import { requestSettingsAction } from '../lib/settingsActions';
import FeedbackButton from '../components/FeedbackButton';

registerStrings({
  'settings.title': { de: 'Einstellungen', en: 'Settings' },
  'settings.back': { de: 'Übersicht', en: 'Overview' },
  'settings.appearance': { de: 'Darstellung', en: 'Appearance' },
  'settings.language': { de: 'Sprache', en: 'Language' },
  'settings.languageDe': { de: 'Deutsch', en: 'German' },
  'settings.languageEn': { de: 'Englisch', en: 'English' },
  'settings.featuredCarousel': { de: 'Bildkacheln „Empfohlen für dich"', en: 'Image tiles "Recommended for you"' },
  'settings.notifications': { de: 'Benachrichtigungen', en: 'Notifications' },
  'settings.push': { de: 'Push-Benachrichtigungen', en: 'Push notifications' },
  'settings.reminder': { de: 'Erinnerungszeitpunkt', en: 'Reminder timing' },
  'settings.followedOrganizers': { de: 'Gefolgte Veranstalter', en: 'Followed organizers' },
  'settings.followedOrganizersEmpty': {
    de: 'Du folgst noch keinem Veranstalter — auf einer Eventseite über den Namen des Veranstalters folgen.',
    en: "You're not following any organizers yet — follow one from an event page via the organizer's name.",
  },
  'settings.unfollow': { de: 'Entfolgen', en: 'Unfollow' },
  'settings.mySearches': { de: 'Meine Suchen', en: 'My searches' },
  'settings.savedSearches': { de: 'Gespeicherte Suchen', en: 'Saved searches' },
  'settings.feedbackAndData': { de: 'Feedback & Daten', en: 'Feedback & data' },
  'settings.feedback': { de: 'Feedback geben', en: 'Send feedback' },
  'settings.refresh': { de: 'Events aktualisieren', en: 'Refresh events' },
});

// Entfernt die untere Trennlinie der jeweils letzten sichtbaren Zeile pro
// Gruppe — React Native kennt kein CSS-:last-child, konditional
// eingeblendete Zeilen (z.B. Erinnerungszeitpunkt nur bei aktiviertem Push)
// verschieben aber, welche Zeile "die letzte" ist.
function SettingsGroup({ children }: { children: React.ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.group}>
      {items.map((child, i) =>
        i === items.length - 1 ? cloneElement(child as React.ReactElement<{ last?: boolean }>, { last: true }) : child
      )}
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  badge,
  onPress,
  disabled,
  right,
  last,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  badge?: number;
  onPress?: () => void;
  disabled?: boolean;
  right?: React.ReactNode;
  last?: boolean;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={[styles.row, last && styles.rowLast]} onPress={onPress} disabled={disabled}>
      <Ionicons name={icon} size={19} color="#999" style={styles.rowIcon} />
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      {typeof badge === 'number' && badge > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      )}
      {right ?? (onPress && <Ionicons name="chevron-forward" size={16} color="#555" />)}
    </Wrapper>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { t, language, toggleLanguage } = useTranslation();
  const { pushEnabled, pushBusy, togglePush } = usePushEnabled();
  const { showFeaturedCarousel, setShowFeaturedCarousel } = useShowFeaturedCarousel();
  const { offsetsMinutes: reminderOffsets } = useReminderSettings();
  const { savedSearches } = useSavedSearches();
  const { followedOrganizers, toggleFollow } = useFollowedOrganizers();
  const [showOrganizers, setShowOrganizers] = useState(false);
  const [refreshRequested, setRefreshRequested] = useState(false);

  function goBackWithAction(action: 'open-reminder' | 'open-saved-searches') {
    requestSettingsAction(action);
    router.back();
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('settings.back')}>
          <Ionicons name="chevron-back" size={26} color="#0af" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('settings.title')}</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionLabel}>{t('settings.appearance')}</Text>
        <SettingsGroup>
          <SettingsRow
            icon="language-outline"
            label={t('settings.language')}
            value={language === 'de' ? t('settings.languageDe') : t('settings.languageEn')}
            onPress={toggleLanguage}
          />
          <SettingsRow
            icon="image-outline"
            label={t('settings.featuredCarousel')}
            right={
              <Switch
                value={showFeaturedCarousel}
                onValueChange={setShowFeaturedCarousel}
                trackColor={{ false: '#333', true: '#0af' }}
                thumbColor="#fff"
              />
            }
          />
        </SettingsGroup>

        <Text style={styles.sectionLabel}>{t('settings.notifications')}</Text>
        <SettingsGroup>
          <SettingsRow
            icon={pushEnabled ? 'notifications' : 'notifications-off-outline'}
            label={t('settings.push')}
            disabled={pushBusy}
            right={
              pushBusy ? (
                <ActivityIndicator size="small" color="#999" />
              ) : (
                <Switch
                  value={pushEnabled}
                  onValueChange={togglePush}
                  trackColor={{ false: '#333', true: '#0af' }}
                  thumbColor="#fff"
                />
              )
            }
          />
          {pushEnabled && (
            <SettingsRow
              icon="time-outline"
              label={t('settings.reminder')}
              badge={reminderOffsets.length}
              onPress={() => goBackWithAction('open-reminder')}
            />
          )}
          <SettingsRow
            icon="people-outline"
            label={t('settings.followedOrganizers')}
            badge={followedOrganizers.length}
            onPress={() => setShowOrganizers((v) => !v)}
            right={<Ionicons name={showOrganizers ? 'chevron-up' : 'chevron-forward'} size={16} color="#555" />}
          />
        </SettingsGroup>
        {showOrganizers && (
          <View style={styles.organizerList}>
            {followedOrganizers.length === 0 ? (
              <Text style={styles.emptyHint}>{t('settings.followedOrganizersEmpty')}</Text>
            ) : (
              followedOrganizers.map((name) => (
                <View key={name} style={styles.organizerRow}>
                  <Text style={styles.organizerName} numberOfLines={1}>{name}</Text>
                  <TouchableOpacity onPress={() => toggleFollow(name)}>
                    <Text style={styles.organizerUnfollow}>{t('settings.unfollow')}</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        )}

        <Text style={styles.sectionLabel}>{t('settings.mySearches')}</Text>
        <SettingsGroup>
          <SettingsRow
            icon="bookmark-outline"
            label={t('settings.savedSearches')}
            badge={savedSearches.length}
            onPress={() => goBackWithAction('open-saved-searches')}
          />
        </SettingsGroup>

        <Text style={styles.sectionLabel}>{t('settings.feedbackAndData')}</Text>
        <SettingsGroup>
          <FeedbackButton
            renderTrigger={(onPress) => (
              <SettingsRow icon="chatbubble-ellipses-outline" label={t('settings.feedback')} onPress={onPress} />
            )}
          />
          <SettingsRow
            icon="refresh-outline"
            label={t('settings.refresh')}
            disabled={refreshRequested}
            onPress={() => {
              setRefreshRequested(true);
              requestSettingsAction('refresh');
              router.back();
            }}
            right={refreshRequested ? <ActivityIndicator size="small" color="#999" /> : undefined}
          />
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingVertical: 10,
  },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  body: { padding: 16, paddingBottom: 40 },
  sectionLabel: {
    color: '#888', fontSize: 12, fontWeight: '700', letterSpacing: 0.5,
    textTransform: 'uppercase', marginTop: 20, marginBottom: 8, marginLeft: 4,
  },
  group: { backgroundColor: '#141414', borderRadius: 14, borderWidth: 1, borderColor: '#1f1f1f', overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: '#1f1f1f',
  },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: { width: 20 },
  rowLabel: { flex: 1, color: '#fff', fontSize: 14.5, fontWeight: '600' },
  rowValue: { color: '#999', fontSize: 13 },
  badge: { backgroundColor: '#fff', borderRadius: 9, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
  organizerList: { backgroundColor: '#0e0e0e', borderRadius: 12, marginTop: 6, padding: 10, gap: 8 },
  emptyHint: { color: '#777', fontSize: 12.5, lineHeight: 18, padding: 4 },
  organizerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  organizerName: { flex: 1, color: '#ddd', fontSize: 13.5 },
  organizerUnfollow: { color: '#ff6b6b', fontSize: 12.5, fontWeight: '700' },
});
