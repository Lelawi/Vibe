import { Stack } from 'expo-router';

export default function Layout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#000' },
        headerTintColor: '#fff',
        headerTitleStyle: { color: '#fff' },
        contentStyle: { backgroundColor: '#000' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Vibe' }} />
      <Stack.Screen name="event/[id]" options={{ title: 'Event' }} />
    </Stack>
  );
}