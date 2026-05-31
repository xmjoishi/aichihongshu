import { Stack } from 'expo-router';

export default function LibraryLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#fff' },
        headerTintColor: '#FF2442',
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        headerShown: false,
      }}
    />
  );
}
