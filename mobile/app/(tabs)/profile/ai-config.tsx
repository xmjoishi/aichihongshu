import {
  View, Text, ScrollView, TextInput, Pressable,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useState, useEffect } from 'react';
import {
  PROVIDERS, getAiConfig, setAiConfig, getApiKey, setApiKey, deleteApiKey,
  type ProviderId, type AiConfig,
} from '../../../services/ai';
import { AuroraBackground, LiquidButton } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys } from '../../../utils/theme';

export default function AiConfigScreen() {
  const [config, setConfig] = useState<AiConfig>({ providerId: 'minimax', modelId: 'MiniMax-M3' });
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [maskedKeys, setMaskedKeys] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const c = await getAiConfig();
      setConfig(c);
      // 读取所有 provider 的 key
      const keys: Record<string, string> = {};
      const masked: Record<string, boolean> = {};
      for (const p of PROVIDERS) {
        const k = await getApiKey(p.id);
        if (k) { keys[p.id] = k; masked[p.id] = true; }
      }
      setApiKeys(keys);
      setMaskedKeys(masked);
    })();
  }, []);

  const currentProvider = PROVIDERS.find((p) => p.id === config.providerId) ?? PROVIDERS[0];

  function selectProvider(id: ProviderId) {
    const provider = PROVIDERS.find((p) => p.id === id)!;
    setConfig({ providerId: id, modelId: provider.models[0].id });
  }

  function selectModel(modelId: string) {
    setConfig((c) => ({ ...c, modelId }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await setAiConfig(config);
      // 保存当前 provider 的 key（如果有输入且未 masked）
      const key = apiKeys[config.providerId];
      if (key && !maskedKeys[config.providerId]) {
        await setApiKey(key.trim(), config.providerId);
        setMaskedKeys((m) => ({ ...m, [config.providerId]: true }));
      }
      Alert.alert('保存成功', `已切换到 ${currentProvider.label}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteKey(providerId: ProviderId) {
    Alert.alert('删除 API Key', `确认删除 ${PROVIDERS.find(p => p.id === providerId)?.label} 的 Key？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          await deleteApiKey(providerId);
          setApiKeys((k) => { const n = { ...k }; delete n[providerId]; return n; });
          setMaskedKeys((m) => { const n = { ...m }; delete n[providerId]; return n; });
        },
      },
    ]);
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={88}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>
            选择用于文本创作的 AI 模型。图片分析固定使用 MiniMax VL-01。
          </Text>

          {/* Provider 选择 */}
          <Text style={styles.groupLabel}>选择服务商</Text>
          <View style={styles.card}>
            {PROVIDERS.map((p, i) => {
              const isSelected = config.providerId === p.id;
              const hasKey = !!apiKeys[p.id];
              return (
                <View key={p.id}>
                  {i > 0 && <View style={styles.divider} />}
                  <Pressable
                    onPress={() => selectProvider(p.id)}
                    style={({ pressed }) => [styles.providerRow, pressed && styles.rowPressed]}
                  >
                    <View style={styles.providerLeft}>
                      <View style={[styles.radio, isSelected && styles.radioSelected]}>
                        {isSelected && <View style={styles.radioDot} />}
                      </View>
                      <View>
                        <Text style={[styles.providerLabel, isSelected && { color: Brand.red }]}>
                          {p.label}
                        </Text>
                        <Text style={styles.providerHint}>{p.keyHint}</Text>
                      </View>
                    </View>
                    {hasKey && (
                      <View style={styles.keyBadge}>
                        <Text style={styles.keyBadgeText}>已配置</Text>
                      </View>
                    )}
                  </Pressable>
                </View>
              );
            })}
          </View>

          {/* 模型选择（当前 provider） */}
          <Text style={styles.groupLabel}>默认模型</Text>
          <View style={styles.card}>
            {currentProvider.models.map((m, i) => {
              const isSelected = config.modelId === m.id;
              return (
                <View key={m.id}>
                  {i > 0 && <View style={styles.divider} />}
                  <Pressable
                    onPress={() => selectModel(m.id)}
                    style={({ pressed }) => [styles.modelRow, pressed && styles.rowPressed]}
                  >
                    <View style={[styles.radio, isSelected && styles.radioSelected]}>
                      {isSelected && <View style={styles.radioDot} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.modelLabel, isSelected && { color: Brand.red }]}>
                        {m.label}
                      </Text>
                      {m.vision && <Text style={styles.modelTag}>支持图片</Text>}
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </View>

          {/* 当前 Provider 的 API Key */}
          <Text style={styles.groupLabel}>API Key — {currentProvider.label}</Text>
          <View style={styles.card}>
            <View style={styles.keyRow}>
              <TextInput
                style={styles.keyInput}
                value={maskedKeys[config.providerId] ? '••••••••••••••••••••••••' : (apiKeys[config.providerId] ?? '')}
                onChangeText={(v) => {
                  setApiKeys((k) => ({ ...k, [config.providerId]: v }));
                  setMaskedKeys((m) => ({ ...m, [config.providerId]: false }));
                }}
                onFocus={() => {
                  if (maskedKeys[config.providerId]) {
                    setApiKeys((k) => ({ ...k, [config.providerId]: '' }));
                    setMaskedKeys((m) => ({ ...m, [config.providerId]: false }));
                  }
                }}
                placeholder={currentProvider.keyPlaceholder}
                placeholderTextColor={TText.tertiary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={false}
              />
              {maskedKeys[config.providerId] && (
                <Pressable onPress={() => handleDeleteKey(config.providerId)} style={styles.deleteBtn}>
                  <Text style={styles.deleteBtnText}>删除</Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* 自定义端点（仅 custom） */}
          {config.providerId === 'custom' && (
            <>
              <Text style={styles.groupLabel}>自定义端点</Text>
              <View style={styles.card}>
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>Base URL</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={config.customBaseUrl ?? ''}
                    onChangeText={(v) => setConfig((c) => ({ ...c, customBaseUrl: v }))}
                    placeholder="https://your-api.com"
                    placeholderTextColor={TText.tertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                </View>
                <View style={styles.divider} />
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>Model Name</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={config.modelId}
                    onChangeText={(v) => setConfig((c) => ({ ...c, modelId: v }))}
                    placeholder="gpt-4o / claude-3-5-sonnet / ..."
                    placeholderTextColor={TText.tertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>
            </>
          )}

          <LiquidButton
            label={saving ? '保存中…' : '保存配置'}
            onPress={handleSave}
            style={{ marginTop: 8 }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12 },

  hint: { fontSize: Font.footnote, color: TText.secondary, lineHeight: 18, paddingHorizontal: 4 },
  groupLabel: {
    fontSize: Font.footnote, fontWeight: Font.semibold, color: TText.tertiary,
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 4, paddingHorizontal: 4,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Glass.borderSubtle, marginLeft: 16 },
  rowPressed: { backgroundColor: 'rgba(0,0,0,0.04)' },

  // ── Provider ────────────────────────────────────────────────
  providerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  providerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  providerLabel: { fontSize: Font.body, fontWeight: Font.medium, color: TText.primary },
  providerHint: { fontSize: Font.caption, color: TText.tertiary, marginTop: 1 },
  keyBadge: {
    backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: Radius.sm,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  keyBadgeText: { fontSize: Font.caption, color: Sys.success, fontWeight: Font.semibold },

  // ── Model ───────────────────────────────────────────────────
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  modelLabel: { fontSize: Font.body, color: TText.primary, fontWeight: Font.medium },
  modelTag: { fontSize: Font.caption, color: Brand.red, marginTop: 1 },

  // ── Radio ───────────────────────────────────────────────────
  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: Glass.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioSelected: { borderColor: Brand.red },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Brand.red },

  // ── Key ─────────────────────────────────────────────────────
  keyRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 4 },
  keyInput: { flex: 1, fontSize: Font.body, color: TText.primary, paddingVertical: 12 },
  deleteBtn: { paddingHorizontal: 4, paddingVertical: 12 },
  deleteBtnText: { fontSize: Font.subheadline, color: Brand.red, fontWeight: Font.medium },

  // ── Custom fields ───────────────────────────────────────────
  fieldRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  fieldLabel: {
    fontSize: Font.caption, color: TText.tertiary,
    fontWeight: Font.semibold, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  fieldInput: { fontSize: Font.body, color: TText.primary, paddingTop: 2 },
});
