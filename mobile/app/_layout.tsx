import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initDb } from '../services/db';
import { useStore } from '../store';

export default function RootLayout() {
  const loadItems = useStore((s) => s.loadItems);
  const loadNotes = useStore((s) => s.loadNotes);
  const loadProfile = useStore((s) => s.loadProfile);

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        await Promise.all([loadItems(), loadNotes(), loadProfile()]);
      } catch (e) {
        console.error('initDb error', e);
      }
    })();
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
