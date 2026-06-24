import {
  View, Text, ScrollView,
  StyleSheet, Pressable,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../../../store';
import { getAiConfig, getApiKey, PROVIDERS } from '../../../services/ai';
import { getMediaPermission } from '../../../services/media';
import { AuroraBackground, LiquidCard } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Sys, Radius } from '../../../utils/theme';

type MenuIconName = keyof typeof Ionicons.glyphMap;

function StatusDot({ ok, warn = false }: { ok: boolean; warn?: boolean }) {
  return (
    <View
      style={[
        styles.statusDot,
        { backgroundColor: ok ? Sys.success : warn ? Sys.warning : Brand.red },
      ]}
    />
  );
}

function MenuItem({
  icon, label, value, onPress, ok, warn = false, last = false,
}: {
  icon: MenuIconName;
  label: string;
  value?: string;
  onPress: () => void;
  ok?: boolean;
  warn?: boolean;
  last?: boolean;
}) {
  return (
    <>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
      >
        <View style={styles.menuLeft}>
          <View style={styles.menuIconWrap}>
            <Ionicons name={icon} size={18} color={Brand.red} />
          </View>
          <Text style={styles.menuLabel}>{label}</Text>
        </View>
        <View style={styles.menuRight}>
          {typeof ok === 'boolean' ? <StatusDot ok={ok} warn={warn} /> : null}
          {value ? <Text style={styles.menuValue} numberOfLines={1}>{value}</Text> : null}
          <Text style={styles.menuChevron}>›</Text>
        </View>
      </Pressable>
      {!last && <View style={styles.menuDivider} />}
    </>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const profile = useStore((s) => s.profile);
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);

  const [aiLabel, setAiLabel] = useState('MiniMax');
  const [hasProviderKey, setHasProviderKey] = useState(false);
  const [hasMiniMaxKey, setHasMiniMaxKey] = useState(false);
  const [mediaState, setMediaState] = useState<'unknown' | 'granted' | 'limited' | 'denied'>('unknown');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const config = await getAiConfig();
        const provider = PROVIDERS.find((p) => p.id === config.providerId);
        const model = provider?.models.find((m) => m.id === config.modelId);
        const [providerKey, miniMaxKey, mediaPermission] = await Promise.all([
          getApiKey(config.providerId),
          getApiKey('minimax'),
          getMediaPermission(),
        ]);

        if (cancelled) return;

        setAiLabel(model?.label.split('（')[0] ?? provider?.label ?? 'MiniMax');
        setHasProviderKey(!!providerKey);
        setHasMiniMaxKey(!!miniMaxKey);
        setMediaState(
          !mediaPermission.granted
            ? 'denied'
            : mediaPermission.limited
              ? 'limited'
              : 'granted'
        );
      })();

      return () => { cancelled = true; };
    }, [])
  );

  const readyCount = notes.filter((n) => n.status === 'ready').length;
  const draftCount = notes.length - readyCount;
  const personaReady = !!(profile?.personaName && profile?.personaTone);
  const aiReady = hasProviderKey && hasMiniMaxKey;

  const workflowText = (() => {
    if (draftCount > 0) return `有 ${draftCount} 篇草稿待修改`;
    if (readyCount > 0) return `有 ${readyCount} 篇内容待导出或发布`;
    if (items.length > 0) return `已有 ${items.length} 张图，可直接去出稿`;
    return '先选图，再让 AI 帮你出稿';
  })();

  const mediaLabel = mediaState === 'granted'
    ? '已授权全部照片'
    : mediaState === 'limited'
      ? '仅授权部分照片'
      : mediaState === 'denied'
        ? '未授权相册'
        : '检查中';

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <View style={[styles.pageHeader, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.pageTitle}>设置</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <LiquidCard style={styles.workflowCard}>
          <Text style={styles.workflowEyebrow}>移动端工作流</Text>
          <Text style={styles.workflowTitle}>选图 → 出稿 → 改稿 → 待发布 / 导出</Text>
          <Text style={styles.workflowDesc}>{workflowText}</Text>

          <View style={styles.workflowChips}>
            <View style={styles.workflowChip}>
              <Text style={styles.workflowChipNum}>{items.length}</Text>
              <Text style={styles.workflowChipLabel}>已入库</Text>
            </View>
            <View style={styles.workflowChip}>
              <Text style={styles.workflowChipNum}>{draftCount}</Text>
              <Text style={styles.workflowChipLabel}>待改稿</Text>
            </View>
            <View style={styles.workflowChip}>
              <Text style={styles.workflowChipNum}>{readyCount}</Text>
              <Text style={styles.workflowChipLabel}>待发布</Text>
            </View>
          </View>
        </LiquidCard>

        <Text style={styles.groupLabel}>核心配置</Text>
        <LiquidCard style={styles.menuCard}>
          <MenuItem
            icon="person-circle-outline"
            label="账号人设"
            value={personaReady ? `${profile?.personaName ?? '已配置'} · 已就绪` : '未配置完整'}
            ok={personaReady}
            onPress={() => router.push('/(tabs)/profile/persona')}
          />
          <MenuItem
            icon="sparkles-outline"
            label="AI 模型"
            value={aiReady ? aiLabel : `${aiLabel} · Key 未就绪`}
            ok={aiReady}
            onPress={() => router.push('/(tabs)/profile/ai-config')}
          />
          <MenuItem
            icon="pulse-outline"
            label="运行诊断"
            value={aiReady && personaReady ? '关键配置正常' : '建议检查环境'}
            ok={aiReady && personaReady}
            warn={aiReady || personaReady}
            onPress={() => router.push('/(tabs)/profile/diagnostics')}
            last
          />
        </LiquidCard>

        <Text style={styles.groupLabel}>设备与数据</Text>
        <LiquidCard style={styles.menuCard}>
          <MenuItem
            icon="images-outline"
            label="相册权限"
            value={mediaLabel}
            ok={mediaState === 'granted'}
            warn={mediaState === 'limited'}
            onPress={() => router.push('/(tabs)/profile/diagnostics')}
          />
          <MenuItem
            icon="folder-open-outline"
            label="数据管理"
            value="清理图库 / 草稿 / 本地记录"
            onPress={() => router.push('/(tabs)/profile/danger')}
            last
          />
        </LiquidCard>

        <Text style={styles.footer}>爱吃红薯 v0.1.0 · 移动端偏创作工具，不做运营大盘</Text>
      </ScrollView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  pageHeader: { paddingHorizontal: 18, paddingBottom: 8 },
  pageTitle: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary },
  content: { padding: 16, paddingBottom: 110, gap: 0 },

  workflowCard: { marginBottom: 20 },
  workflowEyebrow: {
    fontSize: Font.caption,
    fontWeight: Font.semibold,
    color: Brand.red,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  workflowTitle: {
    fontSize: Font.callout,
    fontWeight: Font.semibold,
    color: TText.primary,
    marginTop: 6,
  },
  workflowDesc: {
    fontSize: Font.footnote,
    color: TText.secondary,
    lineHeight: 20,
    marginTop: 6,
  },
  workflowChips: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  workflowChip: {
    flex: 1,
    backgroundColor: '#fafafa',
    borderRadius: Radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  workflowChipNum: {
    fontSize: Font.title3,
    fontWeight: Font.bold,
    color: TText.primary,
  },
  workflowChipLabel: {
    fontSize: Font.caption,
    color: TText.tertiary,
    marginTop: 2,
  },

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
  menuIconWrap: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuLabel: { fontSize: Font.body, color: TText.primary, fontWeight: Font.medium },
  menuRight: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '52%' },
  menuValue: { fontSize: Font.subheadline, color: TText.tertiary, flexShrink: 1, textAlign: 'right' },
  menuChevron: { fontSize: 20, color: TText.tertiary, lineHeight: 22 },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Glass.borderSubtle, marginLeft: 52 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },

  footer: { fontSize: Font.caption, color: TText.tertiary, textAlign: 'center', marginTop: 8 },
});
