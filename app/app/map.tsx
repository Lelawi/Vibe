import { Platform, StyleSheet, Text, SafeAreaView } from 'react-native';
import MapNative from '../components/MapNative';

export default function MapScreen() {
  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Kartenansicht</Text>
        <Text style={styles.text}>
          Die Kartenansicht ist aktuell nur in der nativen App (iPhone/Android)
          verfügbar, nicht in der Web-Vorschau.
        </Text>
      </SafeAreaView>
    );
  }

  return <MapNative />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  text: { color: '#999', fontSize: 14, textAlign: 'center' },
});