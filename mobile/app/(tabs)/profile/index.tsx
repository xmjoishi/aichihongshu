import {
  View, Text, ScrollView,
  StyleSheet, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../../../store';
import { getAiConfig, PROVIDERS } from '../../../services/ai';
import { AuroraBackground, LiquidCard } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Sys } from '../../../utils/theme';

// ─── 菜单行 ────────────────────────────────────────────────────
function MenuItem({
  icon, label, value, onPress, danger = false, last = false,
}: {
  icon: string;
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  return (
    <>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
      >
        <View style={styles.menuLeft}>
          <Text style={styles.menuIcon}>{icon}</Text>
          <Text style={[styles.menuLabel, danger && { color: Brand.red }]}>{label}</Text>
        </View>
        <View style={styles.menuRight}>
          {value ? <Text style={styles.menuValue} numberOfLines={1}>{value}</Text> : null}
          {!danger && <Text style={styles.menuChevron}>›</Text>}
        </View>
      </Pressable>
      {!last && <View style={styles.menuDivider} />}
    </>
  );
}

// ─── 主页 ──────────────────────────────────────────────────────
export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const profile = useStore((s) => s.profile);
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const [aiLabel, setAiLabel] = useState('MiniMax');

  useEffect(() => {
    getAiConfig().then((c) => {
      const provider = PROVIDERS.find((p) => p.id === c.providerId);
      const model = provider?.models.find((m) => m.id === c.modelId);
      setAiLabel(model?.label.split('（')[0] ?? provider?.label ?? 'MiniMax');
    });
  }, []);

  const readyCount = notes.filter((n) => n.status === 'ready').length;
  const draftCount = notes.filter((n) => n.status !== 'ready').length;

  const personaDisplay = profile?.personaName
    ? `${profile.personaName} · ${profile.niche ?? ''}`
    : '未设置';

  return (
    <AuroraBackground style={{ flex: 1 }}>
      {/* 标题行 */}
      <View style={[styles.pageHeader, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.pageTitle}>设置</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

        {/* 统计卡 */}
        <LiquidCard style={styles.statsCard}>
          {[
            { num: items.length, label: '图库', color: TText.primary },
            { num: draftCount,   label: '草稿',  color: TText.primary },
            { num: readyCount,   label: '待发布', color: readyCount > 0 ? Sys.success : TText.primary },
          ].map((s, i) => (
            <View key={s.label} style={[styles.statItem, i < 2 && styles.statDivider]}>
              <Text style={[styles.statNum, { color: s.color }]}>{s.num}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </LiquidCard>

        {/* 分组：创作设置 */}
        <Text style={styles.groupLabel}>创作设置</Text>
        <LiquidCard style={styles.menuCard}>
          <MenuItem
            icon="🎭"
            label="账号人设"
            value={personaDisplay}
            onPress={() => router.push('/(tabs)/profile/persona')}
          />
          <MenuItem
            icon="🤖"
            label="AI 模型"
            value={aiLabel}
            onPress={() => router.push('/(tabs)/profile/ai-config')}
          />
          <MenuItem
            icon="🩺"
            label="运行诊断"
            value="环境/Key/数据"
            onPress={() => router.push('/(tabs)/profile/diagnostics')}
            last
          />
        </LiquidCard>

        {/* 分组：数据 */}
        <Text style={styles.groupLabel}>数据</Text>
        <LiquidCard style={styles.menuCard}>
          <MenuItem
            icon="🗑️"
            label="数据管理"
            onPress={() => router.push('/(tabs)/profile/danger')}
            last
          />
        </LiquidCard>

        {/* 版本 */}
        <Text style={styles.footer}>爱吃红薯 v0.1.0 · 专注家居软装创作</Text>
      </ScrollView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  pageHeader: { paddingHorizontal: 18, paddingBottom: 8 },
  pageTitle: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary },
  content: { padding: 16, paddingBottom: 110, gap: 0 },

  // ── 统计卡 ──────────────────────────────────────────────────
  statsCard: { flexDirection: 'row', gap: 0, paddingHorizontal: 0, paddingVertical: 0, marginBottom: 24 },
  statItem: { flex: 1, alignItems: 'center', paddingVertical: 18 },
  statDivider: { borderRightWidth: 0.5, borderRightColor: Glass.borderSubtle },
  statNum: { fontSize: Font.title1, fontWeight: Font.bold },
  statLabel: { fontSize: Font.caption, color: TText.tertiary, marginTop: 2 },

  // ── 分组标签 ────────────────────────────────────────────────
  groupLabel: {
    fontSize: Font.footnote,
    fontWeight: Font.semibold,
    color: TText.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
    marginTop: 4,
    paddingHorizontal: 4,
  },

  // ── 菜单卡 ──────────────────────────────────────────────────
  menuCard: { gap: 0, paddingHorizontal: 0, paddingVertical: 0, marginBottom: 20 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  menuRowPressed: { backgroundColor: 'rgba(0,0,0,0.04)' },
  menuLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  menuIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  menuLabel: { fontSize: Font.body, color: TText.primary, fontWeight: Font.medium },
  menuRight: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '45%' },
  menuValue: { fontSize: Font.subheadline, color: TText.tertiary, flexShrink: 1 },
  menuChevron: { fontSize: 20, color: TText.tertiary, lineHeight: 22 },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Glass.borderSubtle, marginLeft: 52 },

  // ── 底部 ────────────────────────────────────────────────────
  footer: { fontSize: Font.caption, color: TText.tertiary, textAlign: 'center', marginTop: 8 },
});
