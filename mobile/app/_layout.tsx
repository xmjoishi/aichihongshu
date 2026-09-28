import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initDb } from '../services/db';
import { processNextPcMemoryCommand } from '../services/mobileMemoryCommands';
import { useStore } from '../store';

export default function RootLayout() {
  const loadItems = useStore((s) => s.loadItems);
  const loadNotes = useStore((s) => s.loadNotes);
  const loadProfile = useStore((s) => s.loadProfile);

  useEffect(() => {
    let stopped = false;
    let appIsActive = AppState.currentState === 'active';
    let databaseReady = false;
    let polling = false;

    const poll = async () => {
      if (stopped || !databaseReady || !appIsActive || polling) return;
      polling = true;
      try {
        await processNextPcMemoryCommand();
      } catch {
        // Harness 离线或手机离开局域网时不打扰用户；PC 会按心跳显示离线。
      } finally {
        polling = false;
      }
    };

    (async () => {
      try {
        await initDb();
        databaseReady = true;
        await Promise.all([loadItems(), loadNotes(), loadProfile()]);
        void poll();
      } catch (e) {
        console.error('initDb error', e);
      }
    })();

    const timer = setInterval(() => void poll(), 1_200);
    const subscription = AppState.addEventListener('change', (state) => {
      appIsActive = state === 'active';
      if (appIsActive) void poll();
    });

    return () => {
      stopped = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </GestureHandlerRootView>
  );
}
