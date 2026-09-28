import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  View, Text, ScrollView, TextInput, Pressable,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AuroraBackground, LiquidCard, LiquidButton } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys } from '../../../utils/theme';
import {
  listMemoryEntries,
  createMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  transitionMemoryEntryStatus,
  setMemoryEntryEnabled,
  listExperiencePrompts,
  upsertExperiencePrompt,
  deleteExperiencePrompt,
  syncMemoryWithPc,
  type MobileMemoryEntry,
  type MobileExperiencePrompt,
  type MemoryKind,
  type MemoryConfirmStatus,
} from '../../../services/memory';
import { getPcHarnessConfig } from '../../../services/pcHarness';

const KIND_LABELS: Record<MemoryKind, string> = {
  positioning: '定位与表达',
  expression: '表达偏好',
  fact: '生活事实',
  event: '事件',
  content_history: '内容历史',
};

const STATUS_LABELS: Record<MemoryConfirmStatus, string> = {
  candidate: '候选',
  confirmed: '已确认',
  rejected: '已否定',
  outdated: '已过时',
};

type Tab = 'entries' | 'prompts';

export default function MemoryScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('entries');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const activeSyncCountRef = useRef(0);
  const [entries, setEntries] = useState<MobileMemoryEntry[]>([]);
  const [prompts, setPrompts] = useState<MobileExperiencePrompt[]>([]);
  const [memoryEditing, setMemoryEditing] = useState<MobileMemoryEntry | null>(null);
  const [promptEditing, setPromptEditing] = useState<MobileExperiencePrompt | null>(null);

  // 新增记忆
  const [memoryContent, setMemoryContent] = useState('');
  const [memorySubject, setMemorySubject] = useState('');
  const [memoryKind, setMemoryKind] = useState<MemoryKind>('fact');
  const [memoryConfirmed, setMemoryConfirmed] = useState(false);

  // 新增经验提示词
  const [promptTitle, setPromptTitle] = useState('');
  const [promptContent, setPromptContent] = useState('');
  const [promptApplyScope, setPromptApplyScope] = useState<'global' | 'account'>('account');
  const [promptApplyTarget, setPromptApplyTarget] = useState<'all' | 'compose' | 'chat'>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [e, p] = await Promise.all([listMemoryEntries(), listExperiencePrompts()]);
      setEntries(e);
      setPrompts(p);
    } catch (err) {
      Alert.alert('读取失败', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 手机是唯一事实源：进入记忆页及手机本地改动后，以手机快照更新 PC 缓存。
  // PC 离线时不影响手机本地维护，用户仍可稍后手动重试。
  const uploadSnapshot = useCallback(async () => {
    const config = await getPcHarnessConfig();
    if (!config) return null;
    activeSyncCountRef.current += 1;
    setSyncing(true);
    try {
      const result = await syncMemoryWithPc();
      setSyncError('');
      return result;
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      activeSyncCountRef.current -= 1;
      setSyncing(activeSyncCountRef.current > 0);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      void uploadSnapshot().catch(() => {
        // PC 缓存不可达时仍可独立使用手机记忆；进入页面时静默重试。
      });
    }, [refresh, uploadSnapshot]),
  );

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('mobile-memory-changed', () => {
      void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  async function handleAddMemory() {
    if (!memoryContent.trim()) {
      Alert.alert('内容为空', '写点要记住的事实或事件。');
      return;
    }
    try {
      const input = {
        kind: memoryKind,
        content: memoryContent,
        subject: memorySubject,
        source: memoryEditing?.source ?? '用户输入',
      };
      if (memoryEditing) await updateMemoryEntry(memoryEditing.id, input);
      else await createMemoryEntry({ ...input, confirmStatus: memoryConfirmed ? 'confirmed' : 'candidate' });
      void uploadSnapshot().catch(() => {});
      setMemoryContent('');
      setMemorySubject('');
      setMemoryConfirmed(false);
      setMemoryEditing(null);
      await refresh();
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : String(err));
    }
  }

  async function handleTransition(entry: MobileMemoryEntry, next: MemoryConfirmStatus) {
    try {
      await transitionMemoryEntryStatus(entry.id, next);
      void uploadSnapshot().catch(() => {});
      await refresh();
    } catch (err) {
      Alert.alert('操作失败', err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleMemory(entry: MobileMemoryEntry) {
    try {
      await setMemoryEntryEnabled(entry.id, !entry.enabled);
      void uploadSnapshot().catch(() => {});
      await refresh();
    } catch (err) {
      Alert.alert('操作失败', err instanceof Error ? err.message : String(err));
    }
  }

  function beginEditMemory(entry: MobileMemoryEntry) {
    setMemoryEditing(entry);
    setMemoryKind(entry.kind);
    setMemoryContent(entry.content);
    setMemorySubject(entry.subject);
  }

  async function handleDeleteMemory(entry: MobileMemoryEntry) {
    Alert.alert('删除记忆', `删除「${entry.content.slice(0, 20)}…」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteMemoryEntry(entry.id);
            void uploadSnapshot().catch(() => {});
            await refresh();
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);
  }

  async function handleAddPrompt() {
    if (!promptTitle.trim() || !promptContent.trim()) {
      Alert.alert('请补全', '标题和内容都要填。');
      return;
    }
    try {
      await upsertExperiencePrompt({
        id: promptEditing?.id,
        title: promptTitle,
        content: promptContent,
        enabled: promptEditing?.enabled ?? true,
        applyScope: promptApplyScope,
        applyTarget: promptApplyTarget,
        sortOrder: promptEditing?.sortOrder ?? 0,
      });
      void uploadSnapshot().catch(() => {});
      setPromptTitle('');
      setPromptContent('');
      setPromptEditing(null);
      setPromptApplyScope('account');
      setPromptApplyTarget('all');
      await refresh();
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : String(err));
    }
  }

  function beginEditPrompt(prompt: MobileExperiencePrompt) {
    setPromptEditing(prompt);
    setPromptTitle(prompt.title);
    setPromptContent(prompt.content);
    setPromptApplyScope(prompt.applyScope);
    setPromptApplyTarget(prompt.applyTarget);
  }

  async function handleTogglePrompt(prompt: MobileExperiencePrompt) {
    try {
      await upsertExperiencePrompt({
        id: prompt.id,
        title: prompt.title,
        content: prompt.content,
        enabled: !prompt.enabled,
        applyScope: prompt.applyScope,
        applyTarget: prompt.applyTarget,
        sortOrder: prompt.sortOrder,
      });
      void uploadSnapshot().catch(() => {});
      await refresh();
    } catch (err) {
      Alert.alert('操作失败', err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeletePrompt(prompt: MobileExperiencePrompt) {
    Alert.alert('删除经验提示词', `删除「${prompt.title}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteExperiencePrompt(prompt.id);
            void uploadSnapshot().catch(() => {});
            await refresh();
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);
  }

  async function handleSync() {
    try {
      const result = await uploadSnapshot();
      if (!result) throw new Error('尚未配置 PC Harness，请先在“PC Harness”里连接');
      Alert.alert(
        '手机记忆已上传',
        `已上传 ${result.pushedEntries} 条记忆、${result.pushedPrompts} 条经验；清除 PC 缓存中的 ${result.deletedEntries} 条过期记忆、${result.deletedPrompts} 条过期经验。`,
      );
      await refresh();
    } catch (err) {
      Alert.alert('同步失败', err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <AuroraBackground>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>记忆</Text>
        <Text style={styles.subtitle}>
          手机端是手机记忆的唯一事实源。进入此页和手机端修改后，会将完整快照上传到 PC 缓存；PC 在线修改由手机本地保存后再回传。PC 缓存不会下发到手机。
        </Text>

        {/* Tab */}
        <View style={styles.tabRow}>
          {([
            { key: 'entries' as const, label: `事实与事件 ${entries.length}` },
            { key: 'prompts' as const, label: `经验提示词 ${prompts.length}` },
          ]).map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
            >
              <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable onPress={handleSync} disabled={syncing} style={styles.syncBtn}>
          {syncing ? (
            <ActivityIndicator size="small" color={Brand.red} />
          ) : (
            <Ionicons name="sync-outline" size={16} color={Brand.red} />
          )}
          <Text style={styles.syncLabel}>{syncing ? '上传并对账中…' : '上传手机记忆到 PC 缓存'}</Text>
        </Pressable>
        {syncError ? (
          <Text style={{ color: '#B45309', fontSize: 12, marginTop: 8 }}>
            手机数据仍保存在本机，PC 缓存尚未更新：{syncError}
          </Text>
        ) : null}

        {loading && <ActivityIndicator style={{ marginTop: 24 }} color={Brand.red} />}

        {tab === 'entries' && !loading && (
          <View style={styles.list}>
            {entries.length === 0 && (
              <Text style={styles.empty}>还没有记忆，下方添加一条事实或事件</Text>
            )}
            {entries.map((entry) => (
              <LiquidCard key={entry.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.badgeRow}>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{KIND_LABELS[entry.kind]}</Text>
                    </View>
                    <View style={[styles.badge, entry.confirmStatus === 'confirmed' ? styles.badgeOk : styles.badgeWarn]}>
                      <Text style={styles.badgeText}>{STATUS_LABELS[entry.confirmStatus]}</Text>
                    </View>
                    {!entry.enabled ? <View style={styles.badge}><Text style={styles.badgeText}>已停用</Text></View> : null}
                    {entry.subject ? <Text style={styles.meta}>{entry.subject}</Text> : null}
                  </View>
                  <View style={styles.iconRow}>
                    <Pressable onPress={() => beginEditMemory(entry)} hitSlop={8}>
                      <Ionicons name="create-outline" size={18} color={TText.secondary} />
                    </Pressable>
                    <Pressable onPress={() => void handleToggleMemory(entry)} hitSlop={8}>
                      <Ionicons name={entry.enabled ? 'toggle' : 'toggle-outline'} size={22} color={entry.enabled ? Brand.red : TText.secondary} />
                    </Pressable>
                    <Pressable onPress={() => handleDeleteMemory(entry)} hitSlop={8}>
                      <Ionicons name="trash-outline" size={18} color={TText.secondary} />
                    </Pressable>
                  </View>
                </View>
                <Text style={styles.cardBody}>{entry.content}</Text>
                {entry.source ? <Text style={styles.meta}>来源：{entry.source}</Text> : null}
                <View style={styles.actionRow}>
                  {entry.confirmStatus === 'candidate' && (
                    <>
                      <Pressable onPress={() => handleTransition(entry, 'confirmed')} style={styles.actionBtn}>
                        <Ionicons name="checkmark-circle-outline" size={18} color={Sys.success} />
                        <Text style={styles.actionLabel}>确认</Text>
                      </Pressable>
                      <Pressable onPress={() => handleTransition(entry, 'rejected')} style={styles.actionBtn}>
                        <Ionicons name="close-circle-outline" size={18} color={Brand.red} />
                        <Text style={styles.actionLabel}>否定</Text>
                      </Pressable>
                    </>
                  )}
                  {entry.confirmStatus === 'confirmed' && (
                    <Pressable onPress={() => handleTransition(entry, 'outdated')} style={styles.actionBtn}>
                      <Ionicons name="time-outline" size={18} color={TText.secondary} />
                      <Text style={styles.actionLabel}>过时</Text>
                    </Pressable>
                  )}
                </View>
              </LiquidCard>
            ))}

            <LiquidCard style={styles.formCard}>
              <Text style={styles.formTitle}>{memoryEditing ? '编辑记忆' : '新增记忆'}</Text>
              <View style={styles.badgeRow}>
                {(Object.keys(KIND_LABELS) as MemoryKind[]).map((kind) => (
                  <Pressable
                    key={kind}
                    onPress={() => setMemoryKind(kind)}
                    style={[styles.chip, memoryKind === kind && styles.chipActive]}
                  >
                    <Text style={[styles.chipLabel, memoryKind === kind && styles.chipLabelActive]}>
                      {KIND_LABELS[kind]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={styles.input}
                placeholder="主体（可选），如：门后置物架"
                value={memorySubject}
                onChangeText={setMemorySubject}
              />
              <TextInput
                style={[styles.input, styles.multiline]}
                placeholder="记忆内容，如：旧塑料架踢脚线卡住，已换金属架"
                value={memoryContent}
                onChangeText={setMemoryContent}
                multiline
              />
              {!memoryEditing && <Pressable onPress={() => setMemoryConfirmed(!memoryConfirmed)} style={styles.checkRow}>
                <Ionicons
                  name={memoryConfirmed ? 'checkbox-outline' : 'square-outline'}
                  size={18}
                  color={memoryConfirmed ? Brand.red : TText.secondary}
                />
                <Text style={styles.checkLabel}>直接确认（默认存为候选，需确认后才注入）</Text>
              </Pressable>}
              <LiquidButton label={memoryEditing ? '保存修改' : '添加记忆'} onPress={handleAddMemory} />
              {memoryEditing && (
                <Pressable onPress={() => { setMemoryEditing(null); setMemoryContent(''); setMemorySubject(''); }} style={styles.cancelEdit}>
                  <Text style={styles.actionLabel}>取消编辑</Text>
                </Pressable>
              )}
            </LiquidCard>
          </View>
        )}

        {tab === 'prompts' && !loading && (
          <View style={styles.list}>
            {prompts.length === 0 && (
              <Text style={styles.empty}>还没有经验提示词，下方添加一条</Text>
            )}
            {prompts.map((prompt) => (
              <LiquidCard key={prompt.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.badgeRow}>
                    <Text style={styles.cardTitle}>{prompt.title}</Text>
                    {!prompt.enabled && (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>已停用</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.iconRow}>
                    <Pressable onPress={() => beginEditPrompt(prompt)} hitSlop={8}>
                      <Ionicons name="create-outline" size={18} color={TText.secondary} />
                    </Pressable>
                    <Pressable onPress={() => handleTogglePrompt(prompt)} hitSlop={8}>
                      <Ionicons
                        name={prompt.enabled ? 'toggle' : 'toggle-outline'}
                        size={22}
                        color={prompt.enabled ? Brand.red : TText.secondary}
                      />
                    </Pressable>
                    <Pressable onPress={() => handleDeletePrompt(prompt)} hitSlop={8}>
                      <Ionicons name="trash-outline" size={18} color={TText.secondary} />
                    </Pressable>
                  </View>
                </View>
                <Text style={styles.cardBody}>{prompt.content}</Text>
              </LiquidCard>
            ))}

            <LiquidCard style={styles.formCard}>
              <Text style={styles.formTitle}>{promptEditing ? '编辑经验提示词' : '新增经验提示词'}</Text>
              <TextInput
                style={styles.input}
                placeholder="标题（≤40 字），如：口吻偏好"
                value={promptTitle}
                onChangeText={setPromptTitle}
              />
              <TextInput
                style={[styles.input, styles.multiline]}
                placeholder="内容（≤300 字），如：先吐槽再给结论，短句换行"
                value={promptContent}
                onChangeText={setPromptContent}
                multiline
              />
              <Text style={styles.meta}>适用账号</Text>
              <View style={styles.badgeRow}>
                {([
                  { key: 'account' as const, label: '当前账号' },
                  { key: 'global' as const, label: '全部账号' },
                ]).map((item) => (
                  <Pressable key={item.key} onPress={() => setPromptApplyScope(item.key)} style={[styles.chip, promptApplyScope === item.key && styles.chipActive]}>
                    <Text style={[styles.chipLabel, promptApplyScope === item.key && styles.chipLabelActive]}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.meta}>适用场景</Text>
              <View style={styles.badgeRow}>
                {([
                  { key: 'all' as const, label: '出稿和对话' },
                  { key: 'compose' as const, label: '仅出稿' },
                  { key: 'chat' as const, label: '仅对话' },
                ]).map((item) => (
                  <Pressable key={item.key} onPress={() => setPromptApplyTarget(item.key)} style={[styles.chip, promptApplyTarget === item.key && styles.chipActive]}>
                    <Text style={[styles.chipLabel, promptApplyTarget === item.key && styles.chipLabelActive]}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
              <LiquidButton label={promptEditing ? '保存修改' : '添加经验提示词'} onPress={handleAddPrompt} />
              {promptEditing && (
                <Pressable onPress={() => { setPromptEditing(null); setPromptTitle(''); setPromptContent(''); setPromptApplyScope('account'); setPromptApplyTarget('all'); }} style={styles.cancelEdit}>
                  <Text style={styles.actionLabel}>取消编辑</Text>
                </Pressable>
              )}
            </LiquidCard>
          </View>
        )}

        <Pressable onPress={() => router.push('/(tabs)/profile/pc-harness')} style={styles.linkBtn}>
          <Ionicons name="desktop-outline" size={16} color={Brand.red} />
          <Text style={styles.linkLabel}>PC Harness 连接设置</Text>
        </Pressable>
      </ScrollView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 120, gap: 12 },
  title: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary },
  subtitle: { fontSize: Font.footnote, color: TText.secondary, lineHeight: 18 },
  tabRow: {
    flexDirection: 'row',
    backgroundColor: Glass.bgStrong,
    borderRadius: Radius.md,
    padding: 4,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  tabBtnActive: { backgroundColor: '#ffffff' },
  tabLabel: { fontSize: Font.subheadline, color: TText.secondary, fontWeight: Font.medium },
  tabLabelActive: { color: Brand.red },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.red,
    backgroundColor: '#fff5f6',
  },
  syncLabel: { color: Brand.red, fontSize: Font.subheadline, fontWeight: Font.medium },
  list: { gap: 12 },
  empty: {
    textAlign: 'center',
    color: TText.secondary,
    fontSize: Font.footnote,
    paddingVertical: 24,
  },
  card: { gap: 8 },
  cancelEdit: { alignItems: 'center', paddingVertical: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  badge: {
    backgroundColor: '#f4f4f5',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  badgeOk: { backgroundColor: '#ecfdf5' },
  badgeWarn: { backgroundColor: '#fff7ed' },
  badgeText: { fontSize: Font.caption, color: TText.secondary },
  cardTitle: { fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary },
  cardBody: { fontSize: Font.footnote, color: TText.primary, lineHeight: 20 },
  meta: { fontSize: Font.caption, color: TText.secondary },
  actionRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionLabel: { fontSize: Font.footnote, color: TText.secondary },
  formCard: { gap: 10 },
  formTitle: { fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    backgroundColor: '#ffffff',
    borderRadius: Radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: Font.footnote,
    color: TText.primary,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: '#f4f4f5',
  },
  chipActive: { backgroundColor: Brand.red },
  chipLabel: { fontSize: Font.caption, color: TText.secondary },
  chipLabelActive: { color: '#ffffff', fontWeight: Font.medium },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkLabel: { fontSize: Font.caption, color: TText.secondary, flex: 1 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  linkLabel: { color: Brand.red, fontSize: Font.footnote },
});
