import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  View, Text, ScrollView, TextInput, Pressable, Modal,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
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
import { DEFAULT_WRITING_EXPERIENCE, MOBILE_OUTPUT_RULES, EXPERIENCE_CONTENT_LIMIT, countPromptCharacters } from '../../../services/writingRules';
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
type EntryFilter = 'all' | 'pending' | 'using';
type MoreTarget =
  | { type: 'entry'; item: MobileMemoryEntry }
  | { type: 'prompt'; item: MobileExperiencePrompt };

export default function MemoryScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('entries');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncStatus, setSyncStatus] = useState<'checking' | 'unpaired' | 'synced' | 'failed'>('checking');
  const [syncErrorExpanded, setSyncErrorExpanded] = useState(false);
  const [systemRulesVisible, setSystemRulesVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [editor, setEditor] = useState<Tab | null>(null);
  const [moreTarget, setMoreTarget] = useState<MoreTarget | null>(null);
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
  const [promptEnabled, setPromptEnabled] = useState(true);
  const activePromptCount = prompts.filter((prompt) => prompt.enabled).length;

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
    if (!config) {
      setSyncStatus('unpaired');
      return null;
    }
    activeSyncCountRef.current += 1;
    setSyncing(true);
    try {
      const result = await syncMemoryWithPc();
      setSyncError('');
      setSyncErrorExpanded(false);
      setSyncStatus('synced');
      return result;
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
      setSyncErrorExpanded(false);
      setSyncStatus('failed');
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
      setEditor(null);
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
    setMemoryConfirmed(false);
    setEditor('entries');
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
        enabled: promptEnabled,
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
      setPromptEnabled(true);
      await refresh();
      setEditor(null);
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
    setPromptEnabled(prompt.enabled);
    setEditor('prompts');
  }

  async function handleTogglePrompt(prompt: MobileExperiencePrompt) {
    if (!prompt.enabled && activePromptCount >= 10) {
      Alert.alert('已达启用上限', '每个记忆池最多启用 10 条写作经验，请先停用一条。');
      return;
    }
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

  function beginNewMemory() {
    setMemoryEditing(null);
    setMemoryContent('');
    setMemorySubject('');
    setMemoryKind('fact');
    setMemoryConfirmed(false);
    setEditor('entries');
  }

  function beginNewPrompt() {
    setPromptEditing(null);
    setPromptTitle('');
    setPromptContent('');
    setPromptApplyScope('account');
    setPromptApplyTarget('all');
    setPromptEnabled(activePromptCount < 10);
    setEditor('prompts');
  }

  function closeEditor() {
    setEditor(null);
    setMemoryEditing(null);
    setPromptEditing(null);
  }

  function openMore(target: MoreTarget) {
    setMoreTarget(target);
  }

  const query = searchText.trim().toLocaleLowerCase();
  const matchesQuery = (value: string) => !query || value.toLocaleLowerCase().includes(query);
  const filteredEntries = entries.filter((entry) => {
    const isUsing = entry.confirmStatus === 'confirmed' && entry.validStatus === 'valid' && entry.enabled;
    const matchesFilter = entryFilter === 'all'
      || (entryFilter === 'pending' && entry.confirmStatus === 'candidate')
      || (entryFilter === 'using' && isUsing);
    const searchable = `${entry.content} ${entry.subject} ${entry.source} ${KIND_LABELS[entry.kind]} ${STATUS_LABELS[entry.confirmStatus]}`;
    return matchesFilter && matchesQuery(searchable);
  });
  const showEditor = editor !== null;

  return (
    <AuroraBackground>
      <Stack.Screen
        options={{
          title: '记忆',
          headerRight: () => (
            <Pressable
              onPress={tab === 'entries' ? beginNewMemory : beginNewPrompt}
              hitSlop={10}
              style={styles.headerAddButton}
              accessibilityRole="button"
              accessibilityLabel={tab === 'prompts' ? '新增写作经验' : '新增记忆'}
            >
              <Ionicons name="add-circle" size={25} color={Brand.red} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleRow}>
          <View style={styles.titleBlock}>
            <Text style={styles.subtitle}>管理手机记忆与写作经验；待确认内容不会用于 AI。</Text>
          </View>
        </View>

        <View style={styles.tabRow}>
          {([
            { key: 'entries' as const, label: '记忆' },
            { key: 'prompts' as const, label: '写作经验' },
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
        <Pressable onPress={() => setSystemRulesVisible(true)} style={styles.secondaryLink}>
          <Ionicons name="reader-outline" size={14} color={TText.tertiary} />
          <Text style={styles.secondaryLinkLabel}>查看系统规则（只读）</Text>
        </Pressable>

        <View style={styles.syncCard}>
          <View style={styles.syncStatusCopy}>
            <Text style={styles.syncTitle}>电脑端副本</Text>
            <Text style={[styles.syncDescription, syncStatus === 'failed' && styles.syncErrorText]} numberOfLines={syncStatus === 'failed' && syncErrorExpanded ? undefined : 2}>
              {syncing ? '正在上传手机数据…'
                : syncStatus === 'synced' ? '电脑端副本已更新'
                  : syncStatus === 'failed' ? `尚未更新：${syncError}`
                    : syncStatus === 'unpaired' ? '手机记忆仍保存在本机，可连接 PC 更新电脑端副本'
                      : '检查连接状态中…'}
            </Text>
            {syncStatus === 'failed' ? (
              <Pressable onPress={() => setSyncErrorExpanded((expanded) => !expanded)} accessibilityRole="button">
                <Text style={styles.errorDetailsLabel}>{syncErrorExpanded ? '收起错误详情' : '查看完整错误原因'}</Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={() => syncStatus === 'unpaired' ? router.push('/(tabs)/profile/pc-harness') : void handleSync()}
            disabled={syncing || syncStatus === 'checking'}
            style={styles.syncAction}
            accessibilityRole="button"
            accessibilityLabel={syncStatus === 'unpaired' ? '连接 PC' : '同步到 PC'}
          >
            {syncing ? <ActivityIndicator size="small" color={Brand.red} /> : null}
            <Text style={styles.syncActionLabel}>{syncing ? '同步中' : syncStatus === 'unpaired' ? '去连接' : '同步'}</Text>
          </Pressable>
        </View>

        {loading && <ActivityIndicator style={{ marginTop: 24 }} color={Brand.red} />}

        {tab === 'entries' && !loading && (
          <View style={styles.list}>
            <TextInput
              style={styles.searchInput}
              placeholder="搜索内容、主体或来源"
              placeholderTextColor={TText.tertiary}
              value={searchText}
              onChangeText={setSearchText}
              returnKeyType="search"
              accessibilityLabel="搜索记忆"
            />
            <View style={styles.filterRow}>
              {([
                { key: 'all' as const, label: `全部 ${entries.length}` },
                { key: 'pending' as const, label: `待确认 ${entries.filter((entry) => entry.confirmStatus === 'candidate').length}` },
                { key: 'using' as const, label: `使用中 ${entries.filter((entry) => entry.confirmStatus === 'confirmed' && entry.validStatus === 'valid' && entry.enabled).length}` },
              ]).map((filter) => (
                <Pressable
                  key={filter.key}
                  onPress={() => setEntryFilter(filter.key)}
                  style={[styles.filterChip, entryFilter === filter.key && styles.filterChipActive]}
                >
                  <Text style={[styles.filterLabel, entryFilter === filter.key && styles.filterLabelActive]}>{filter.label}</Text>
                </Pressable>
              ))}
            </View>
            {filteredEntries.length === 0 && (
              <Text style={styles.empty}>{entries.length === 0 ? '还没有记忆，点右上角新增一条' : '没有符合条件的记忆'}</Text>
            )}
            {filteredEntries.map((entry) => (
              <LiquidCard key={entry.id} style={styles.card}>
                <View style={styles.badgeRow}>
                  <View style={styles.badge}><Text style={styles.badgeText}>{KIND_LABELS[entry.kind]}</Text></View>
                  <View style={[styles.badge, entry.confirmStatus === 'candidate' ? styles.badgeWarn : styles.badgeOk]}>
                    <Text style={styles.badgeText}>{entry.confirmStatus === 'candidate' ? '待确认' : STATUS_LABELS[entry.confirmStatus]}</Text>
                  </View>
                  {entry.confirmStatus === 'candidate' ? (
                    <View style={styles.badge}><Text style={styles.badgeText}>AI 暂不使用</Text></View>
                  ) : entry.confirmStatus === 'confirmed' ? (
                    <View style={[styles.badge, entry.enabled && entry.validStatus === 'valid' ? styles.badgeOk : undefined]}>
                      <Text style={styles.badgeText}>{entry.validStatus !== 'valid' ? 'AI 暂不使用' : entry.enabled ? '使用中' : '已停用'}</Text>
                    </View>
                  ) : (
                    <View style={styles.badge}><Text style={styles.badgeText}>AI 暂不使用</Text></View>
                  )}
                </View>
                {entry.subject ? <Text style={styles.subject}>{entry.subject}</Text> : null}
                <Text style={styles.cardBody}>{entry.content}</Text>
                {entry.source ? <Text style={styles.meta}>来源：{entry.source}</Text> : null}
                <View style={styles.cardActions}>
                  {entry.confirmStatus === 'candidate' && (
                    <>
                      <Pressable onPress={() => handleTransition(entry, 'confirmed')} style={[styles.primarySmallAction, styles.confirmAction]}>
                        <Ionicons name="checkmark-circle-outline" size={16} color={Sys.success} />
                        <Text style={[styles.primarySmallActionLabel, { color: Sys.success }]}>确认</Text>
                      </Pressable>
                      <Pressable onPress={() => handleTransition(entry, 'rejected')} style={styles.secondarySmallAction}>
                        <Text style={styles.actionLabel}>忽略</Text>
                      </Pressable>
                    </>
                  )}
                  <Pressable onPress={() => openMore({ type: 'entry', item: entry })} style={styles.moreButton} accessibilityRole="button" accessibilityLabel="更多记忆操作">
                    <Ionicons name="ellipsis-horizontal" size={18} color={TText.secondary} />
                    <Text style={styles.actionLabel}>更多</Text>
                  </Pressable>
                </View>
              </LiquidCard>
            ))}
          </View>
        )}

        {tab === 'prompts' && !loading && (
          <View style={styles.list}>
            <View style={styles.experienceSummary}>
              <Ionicons name="sparkles-outline" size={16} color={Brand.red} />
              <Text style={styles.experienceSummaryText}>已启用 {activePromptCount} / 10 条</Text>
              <Text style={styles.meta}>适用场景显示在每条经验下</Text>
            </View>
            <TextInput
              style={styles.searchInput}
              placeholder="搜索标题或经验内容"
              placeholderTextColor={TText.tertiary}
              value={searchText}
              onChangeText={setSearchText}
              returnKeyType="search"
              accessibilityLabel="搜索写作经验"
            />
            {prompts.filter((prompt) => matchesQuery(`${prompt.title} ${prompt.content}`)).length === 0 && (
              <Text style={styles.empty}>{prompts.length === 0 ? '还没有写作经验，点右上角新增' : '没有符合搜索条件的经验'}</Text>
            )}
            {prompts.filter((prompt) => matchesQuery(`${prompt.title} ${prompt.content}`)).map((prompt) => (
              <LiquidCard key={prompt.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.badgeRow}>
                    <Text style={styles.cardTitle}>{prompt.title}</Text>
                    <View style={[styles.badge, prompt.enabled ? styles.badgeOk : undefined]}>
                      <Text style={styles.badgeText}>{prompt.enabled ? '使用中' : '已停用'}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.badgeRow}>
                  <View style={styles.badge}><Text style={styles.badgeText}>{prompt.applyScope === 'global' ? '全部账号' : '当前账号'}</Text></View>
                  <View style={styles.badge}><Text style={styles.badgeText}>{prompt.applyTarget === 'all' ? '出稿和对话' : prompt.applyTarget === 'compose' ? '仅出稿' : '仅对话'}</Text></View>
                </View>
                <Text style={styles.cardBody} numberOfLines={3}>{prompt.content}</Text>
                <View style={styles.cardActions}>
                  <Pressable onPress={() => openMore({ type: 'prompt', item: prompt })} style={styles.moreButton} accessibilityRole="button" accessibilityLabel="更多经验操作">
                    <Ionicons name="ellipsis-horizontal" size={18} color={TText.secondary} />
                    <Text style={styles.actionLabel}>更多</Text>
                  </Pressable>
                </View>
              </LiquidCard>
            ))}
          </View>
        )}
      </ScrollView>

      <Modal visible={showEditor} transparent animationType="slide" onRequestClose={closeEditor}>
        <KeyboardAvoidingView style={styles.editorBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.editorCard}>
            <View style={styles.editorHeader}>
              <Text style={styles.editorTitle}>
                {editor === 'entries' ? (memoryEditing ? '编辑记忆' : '新增记忆') : (promptEditing ? '编辑写作经验' : '新增写作经验')}
              </Text>
              <Pressable onPress={closeEditor} hitSlop={12} accessibilityRole="button" accessibilityLabel="关闭编辑">
                <Ionicons name="close" size={23} color={TText.secondary} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
              {editor === 'entries' ? (
                <>
                  <Text style={styles.meta}>类型</Text>
                  <View style={styles.badgeRow}>
                    {(Object.keys(KIND_LABELS) as MemoryKind[]).map((kind) => (
                      <Pressable key={kind} onPress={() => setMemoryKind(kind)} style={[styles.chip, memoryKind === kind && styles.chipActive]}>
                        <Text style={[styles.chipLabel, memoryKind === kind && styles.chipLabelActive]}>{KIND_LABELS[kind]}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <TextInput style={styles.input} placeholder="主体（可选），如：门后置物架" value={memorySubject} onChangeText={setMemorySubject} />
                  <TextInput
                    style={[styles.input, styles.multiline]}
                    placeholder="记忆内容，如：旧塑料架踢脚线卡住，已换金属架"
                    value={memoryContent}
                    onChangeText={setMemoryContent}
                    multiline
                  />
                  {!memoryEditing ? (
                    <Pressable onPress={() => setMemoryConfirmed(!memoryConfirmed)} style={styles.checkRow}>
                      <Ionicons name={memoryConfirmed ? 'checkbox-outline' : 'square-outline'} size={18} color={memoryConfirmed ? Brand.red : TText.secondary} />
                      <Text style={styles.checkLabel}>直接确认后用于 AI（默认先存为待确认）</Text>
                    </Pressable>
                  ) : null}
                  <LiquidButton label={memoryEditing ? '保存修改' : '添加记忆'} onPress={handleAddMemory} />
                </>
              ) : (
                <>
                  <TextInput style={styles.input} placeholder="标题（≤40 字），如：口吻偏好" value={promptTitle} onChangeText={setPromptTitle} />
                  <TextInput
                    style={[styles.input, styles.multiline]}
                    placeholder="内容（≤5000 字），可填写完整写作经验和示例"
                    value={promptContent}
                    onChangeText={setPromptContent}
                    multiline
                  />
                  <Text style={styles.meta}>{countPromptCharacters(promptContent)} / {EXPERIENCE_CONTENT_LIMIT} 字</Text>
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
                  <Pressable
                    onPress={() => {
                      if (!promptEnabled && activePromptCount >= 10 && !promptEditing?.enabled) {
                        Alert.alert('已达启用上限', '每个记忆池最多启用 10 条写作经验，请先停用一条。');
                        return;
                      }
                      setPromptEnabled((enabled) => !enabled);
                    }}
                    style={styles.checkRow}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: promptEnabled, disabled: !promptEnabled && activePromptCount >= 10 && !promptEditing?.enabled }}
                  >
                    <Ionicons name={promptEnabled ? 'checkbox-outline' : 'square-outline'} size={18} color={promptEnabled ? Brand.red : TText.secondary} />
                    <View style={styles.promptEnabledCopy}>
                      <Text style={styles.checkLabel}>启用这条经验</Text>
                      {activePromptCount >= 10 && !promptEnabled ? <Text style={styles.meta}>已达 10 条上限；可先保存为停用，之后再启用</Text> : null}
                    </View>
                  </Pressable>
                  <LiquidButton label={promptEditing ? '保存修改' : '添加写作经验'} onPress={handleAddPrompt} />
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={systemRulesVisible} transparent animationType="slide" onRequestClose={() => setSystemRulesVisible(false)}>
        <View style={styles.editorBackdrop}>
          <View style={styles.editorCard}>
            <View style={styles.editorHeader}>
              <View>
                <Text style={styles.editorTitle}>系统规则</Text>
                <Text style={styles.meta}>只读 · 手机默认规则</Text>
              </View>
              <Pressable onPress={() => setSystemRulesVisible(false)} hitSlop={12} accessibilityRole="button" accessibilityLabel="关闭系统规则">
                <Ionicons name="close" size={23} color={TText.secondary} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.editorContent}>
              <Text style={styles.subtitle}>以下规则与手机编辑页实际请求共用同一来源。已启用的用户经验优先于默认风格，当篇要求优先；PC 的系统规则覆盖不会下发到手机。</Text>
              <Text style={styles.formTitle}>手机出稿默认经验</Text>
              <Text style={styles.cardBody}>{DEFAULT_WRITING_EXPERIENCE}</Text>
              <Text style={styles.formTitle}>输出规则</Text>
              <Text style={styles.cardBody}>{MOBILE_OUTPUT_RULES}</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={!!moreTarget} transparent animationType="fade" onRequestClose={() => setMoreTarget(null)}>
        <View style={styles.menuBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMoreTarget(null)} />
          <View style={styles.moreMenu}>
            <Text style={styles.moreMenuTitle}>{moreTarget?.type === 'entry' ? '记忆操作' : '写作经验操作'}</Text>
            {moreTarget?.type === 'entry' ? (
              <>
                <MenuAction label="编辑" icon="create-outline" onPress={() => { const item = moreTarget.item; setMoreTarget(null); beginEditMemory(item); }} />
                {moreTarget.item.confirmStatus === 'confirmed' && moreTarget.item.validStatus === 'valid' ? (
                  <MenuAction label={moreTarget.item.enabled ? '停止用于 AI' : '启用用于 AI'} icon="toggle-outline" onPress={() => { const item = moreTarget.item; setMoreTarget(null); void handleToggleMemory(item); }} />
                ) : null}
                {moreTarget.item.confirmStatus === 'confirmed' ? (
                  <MenuAction label="标记为过时" icon="time-outline" onPress={() => { const item = moreTarget.item; setMoreTarget(null); void handleTransition(item, 'outdated'); }} />
                ) : null}
                <MenuAction label="删除" icon="trash-outline" destructive onPress={() => { const item = moreTarget.item; setMoreTarget(null); handleDeleteMemory(item); }} />
              </>
            ) : moreTarget?.type === 'prompt' ? (
              <>
                <MenuAction label="编辑" icon="create-outline" onPress={() => { const item = moreTarget.item; setMoreTarget(null); beginEditPrompt(item); }} />
                <MenuAction label={moreTarget.item.enabled ? '停用经验' : '启用经验'} icon="toggle-outline" onPress={() => { const item = moreTarget.item; setMoreTarget(null); void handleTogglePrompt(item); }} />
                <MenuAction label="删除" icon="trash-outline" destructive onPress={() => { const item = moreTarget.item; setMoreTarget(null); handleDeletePrompt(item); }} />
              </>
            ) : null}
            <Pressable onPress={() => setMoreTarget(null)} style={styles.cancelMenuAction}><Text style={styles.actionLabel}>取消</Text></Pressable>
          </View>
        </View>
      </Modal>
    </AuroraBackground>
  );
}

function MenuAction({ label, icon, onPress, destructive = false }: { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable onPress={onPress} style={styles.menuAction} accessibilityRole="button">
      <Ionicons name={icon} size={18} color={destructive ? Brand.red : TText.secondary} />
      <Text style={[styles.menuActionLabel, destructive && styles.destructiveLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  titleBlock: { flex: 1, gap: 3 },
  subtitle: { fontSize: Font.footnote, color: TText.secondary, lineHeight: 18 },
  headerAddButton: { minWidth: 34, minHeight: 34, alignItems: 'center', justifyContent: 'center' },
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
  secondaryLink: { minHeight: 28, alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  secondaryLinkLabel: { color: TText.tertiary, fontSize: Font.caption },
  syncCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    backgroundColor: '#ffffff',
  },
  syncStatusCopy: { flex: 1, gap: 2 },
  syncTitle: { color: TText.primary, fontSize: Font.caption, fontWeight: Font.semibold },
  syncDescription: { color: TText.secondary, fontSize: Font.caption, lineHeight: 16 },
  syncErrorText: { color: '#b45309' },
  errorDetailsLabel: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.medium, paddingTop: 3 },
  syncAction: { minWidth: 54, minHeight: 34, paddingHorizontal: 8, borderRadius: Radius.sm, backgroundColor: '#fff5f6', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  syncActionLabel: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold },
  list: { gap: 12 },
  searchInput: { borderWidth: StyleSheet.hairlineWidth, borderColor: Glass.border, borderRadius: Radius.md, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 10, color: TText.primary, fontSize: Font.footnote },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterChip: { borderRadius: Radius.pill, backgroundColor: '#f4f4f5', paddingHorizontal: 12, paddingVertical: 7 },
  filterChipActive: { backgroundColor: Brand.red },
  filterLabel: { color: TText.secondary, fontSize: Font.caption },
  filterLabelActive: { color: '#fff', fontWeight: Font.semibold },
  experienceSummary: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  experienceSummaryText: { color: TText.primary, fontSize: Font.caption, fontWeight: Font.semibold },
  empty: {
    textAlign: 'center',
    color: TText.secondary,
    fontSize: Font.footnote,
    paddingVertical: 24,
  },
  card: { gap: 8 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  subject: { fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary },
  cardBody: { fontSize: Font.footnote, color: TText.primary, lineHeight: 20 },
  meta: { fontSize: Font.caption, color: TText.secondary },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  primarySmallAction: { minHeight: 34, paddingHorizontal: 10, borderRadius: Radius.sm, flexDirection: 'row', alignItems: 'center', gap: 5 },
  confirmAction: { backgroundColor: '#ecfdf5' },
  primarySmallActionLabel: { fontSize: Font.caption, fontWeight: Font.semibold },
  secondarySmallAction: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 10 },
  moreButton: { minHeight: 34, marginLeft: 'auto', paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionLabel: { fontSize: Font.footnote, color: TText.secondary },
  promptEnabledCopy: { flex: 1, gap: 3 },
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
  editorBackdrop: { flex: 1, backgroundColor: 'rgba(12,12,14,0.38)', justifyContent: 'center', padding: 18 },
  editorCard: { maxHeight: '92%', backgroundColor: '#fff', borderRadius: Radius.lg, overflow: 'hidden' },
  editorHeader: { minHeight: 54, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Glass.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editorTitle: { fontSize: Font.callout, fontWeight: Font.semibold, color: TText.primary },
  editorContent: { padding: 18, gap: 12 },
  menuBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(12,12,14,0.35)' },
  moreMenu: { backgroundColor: '#fff', borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 28, gap: 4 },
  moreMenuTitle: { fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary, marginBottom: 6 },
  menuAction: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Glass.border },
  menuActionLabel: { color: TText.primary, fontSize: Font.footnote },
  destructiveLabel: { color: Brand.red },
  cancelMenuAction: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
