import { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useStore } from '../../../store';
import { getAiConfig, getApiKey, PROVIDERS } from '../../../services/ai';
import { AuroraBackground, LiquidCard, SectionLabel } from '../../../components/ui';
import { Brand, Font, Sys, Text as TText } from '../../../utils/theme';

type DiagState = {
  providerLabel: string;
  modelLabel: string;
  hasProviderKey: boolean;
  hasMiniMaxKey: boolean;
};

export default function DiagnosticsScreen() {
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const profile = useStore((s) => s.profile);

  const [diag, setDiag] = useState<DiagState>({
    providerLabel: '-',
    modelLabel: '-',
    hasProviderKey: false,
    hasMiniMaxKey: false,
  });

  useEffect(() => {
    (async () => {
      const cfg = await getAiConfig();
      const provider = PROVIDERS.find((p) => p.id === cfg.providerId);
      const model = provider?.models.find((m) => m.id === cfg.modelId);
      const key = await getApiKey(cfg.providerId);
      const mmKey = await getApiKey('minimax');
      setDiag({
        providerLabel: provider?.label ?? cfg.providerId,
        modelLabel: model?.label ?? cfg.modelId,
        hasProviderKey: !!key,
        hasMiniMaxKey: !!mmKey,
      });
    })();
  }, []);

  const readyCount = notes.filter((n) => n.status === 'ready').length;
  const draftCount = notes.length - readyCount;
  const analyzedCount = items.filter((i) => !!i.analysis).length;

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionLabel>运行状态</SectionLabel>
        <LiquidCard style={styles.card}>
          <Row label="人设" value={profile?.personaName ? `已配置（${profile.personaName}）` : '未配置'} ok={!!profile?.personaName} />
          <Row label="图库分析" value={`${analyzedCount}/${items.length}`} ok={analyzedCount > 0 || items.length === 0} />
          <Row label="待发布草稿" value={`${readyCount} 篇`} ok />
          <Row label="草稿总数" value={`${draftCount} 篇`} ok />
        </LiquidCard>

        <SectionLabel>AI 诊断</SectionLabel>
        <LiquidCard style={styles.card}>
          <Row label="Provider" value={diag.providerLabel} ok />
          <Row label="Model" value={diag.modelLabel} ok />
          <Row label="当前 Provider Key" value={diag.hasProviderKey ? '已配置' : '未配置'} ok={diag.hasProviderKey} />
          <Row label="MiniMax Key（图像分析）" value={diag.hasMiniMaxKey ? '已配置' : '未配置'} ok={diag.hasMiniMaxKey} />
        </LiquidCard>

        <Text style={styles.footer}>若 Key 未配置：设置 → AI 模型，填写对应 API Key</Text>
      </ScrollView>
    </AuroraBackground>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={styles.value}>{value}</Text>
        <View style={[styles.dot, { backgroundColor: ok ? Sys.success : Brand.red }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 110 },
  card: { gap: 0, paddingVertical: 6, marginBottom: 18 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f1f1',
  },
  label: { fontSize: Font.body, color: TText.secondary },
  value: { fontSize: Font.subheadline, color: TText.primary, maxWidth: 180, textAlign: 'right' },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  footer: { marginTop: 8, fontSize: Font.caption, color: TText.tertiary, textAlign: 'center' },
});
