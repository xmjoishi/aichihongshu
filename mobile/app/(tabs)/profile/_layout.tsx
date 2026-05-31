import { Stack } from 'expo-router';
import { Brand } from '../../../utils/theme';

export default function ProfileLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#fafafa' },
        headerTintColor: Brand.red,
        headerTitleStyle: { fontWeight: '700', color: '#18181b' },
        headerShadowVisible: false,
        headerBackTitle: '设置',
      }}
    >
      {/* 主设置页：无 header（自绘标题行） */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {/* 二级页：统一由各页面自身设定 title */}
      <Stack.Screen name="persona" options={{ title: '账号人设' }} />
      <Stack.Screen name="ai-config" options={{ title: 'AI 模型' }} />
      <Stack.Screen name="diagnostics" options={{ title: '运行诊断' }} />
      <Stack.Screen name="danger" options={{ title: '数据管理' }} />
    </Stack>
  );
}
