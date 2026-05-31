import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useEffect, useMemo } from 'react';
import { BlurView } from 'expo-blur';
import { useStore } from '../../../../store';
import { chat, buildSystemPrompt, getApiKey, getAiConfig } from '../../../../services/ai';
import { AuroraBackground, InlineNav, LiquidButton, PhImage } from '../../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../../utils/theme';
import Ionicons from '@expo/vector-icons/Ionicons';

// ─── AI 图标按钮 ───────────────────────────────────────────────
function AiBtn({ onPress, loading }: { onPress: () => void; loading?: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.aiBtn}
      disabled={loading}
    >
      {loading
        ? <ActivityIndicator size={13} color={Brand.red} />
        : <Text style={styles.aiBtnIcon}>✦</Text>
      }
      <Text style={styles.aiBtnLabel}>AI</Text>
    </TouchableOpacity>
  );
}

// ─── 区段标题行（左：标签，右：AI 按钮）──────────────────────────
function FieldHeader({
  label, onAi, loading,
}: {
  label: string;
  onAi: () => void;
  loading?: boolean;
}) {
  return (
    <View style={styles.fieldHeader}>
      <Text style={styles.fieldHeaderLabel}>{label}</Text>
      <AiBtn onPress={onAi} loading={loading} />
    </View>
  );
}

// ─── 主页面 ────────────────────────────────────────────────────
export default function EditNoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const noteId = Number(id);
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const profile = useStore((s) => s.profile);
  const updateNote = useStore((s) => s.updateNote);
  const note = notes.find((n) => n.id === noteId);
  const linkedItemIds: number[] = JSON.parse(note?.itemIds ?? '[]');
  const linkedItems = items.filter((i) => linkedItemIds.includes(i.id));

  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [tags, setTags] = useState<string[]>(JSON.parse(note?.tags ?? '[]'));
  const [tagInput, setTagInput] = useState('');

  // 三个字段各自独立的 loading 状态
  const [loadingTitle, setLoadingTitle] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);
  const [loadingTags, setLoadingTags] = useState(false);

  const frequentTags = useMemo(() => {
    const counter = new Map<string, number>();
    for (const n of notes) {
      const arr: string[] = JSON.parse(n.tags ?? '[]');
      for (const raw of arr) {
        const t = raw.trim().replace(/^#/, '');
        if (!t) continue;
        counter.set(t, (counter.get(t) ?? 0) + 1);
      }
    }
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag)
      .filter((tag) => !tags.includes(tag))
      .slice(0, 8);
  }, [notes, tags]);

  useEffect(() => {
    if (note) {
      setTitle(note.title ?? '');
      setBody(note.body ?? '');
      setTags(JSON.parse(note.tags ?? '[]'));
    }
  }, [note?.id]);

  // ── AI 生成（统一错误处理）────────────────────────────────────
  async function callAi(userMsg: string): Promise<string | null> {
    const config = await getAiConfig();
    const key = await getApiKey(config.providerId);
    if (!key) {
      Alert.alert('未配置 API Key', `请先在「设置 → AI 模型配置」中填写 API Key`, [
        { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
        { text: '取消', style: 'cancel' },
      ]);
      return null;
    }
    try {
      const analyses = linkedItems.map((i) => i.analysis ?? '').filter(Boolean);
      const systemPrompt = buildSystemPrompt(profile ?? {}, analyses);
      return await chat([{ role: 'user', content: userMsg }], systemPrompt);
    } catch (e: any) {
      const msg: string = e.message ?? '未知错误';
      if (msg.includes('401') || msg.includes('403') || msg.includes('Key')) {
        Alert.alert('Key 无效', msg, [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ]);
      } else if (msg.includes('网络') || msg.includes('fetch')) {
        Alert.alert('网络错误', '请检查网络连接后重试');
      } else {
        Alert.alert('AI 生成失败', msg);
      }
      return null;
    }
  }

  // ── AI 生成标题 ───────────────────────────────────────────────
  async function handleAiTitle() {
    setLoadingTitle(true);
    const userMsg = body
      ? `根据以下正文内容，生成一个吸引眼球的小红书标题，20字以内，只输出标题本身：\n${body}`
      : '生成一个适合家居软装内容的小红书标题，20字以内，只输出标题本身。';
    const result = await callAi(userMsg);
    if (result) setTitle(result.trim().replace(/^["「『]|["」』]$/g, ''));
    setLoadingTitle(false);
  }

  // ── AI 生成正文 ───────────────────────────────────────────────
  async function handleAiBody() {
    setLoadingBody(true);
    const userMsg = title
      ? `根据标题「${title}」，生成完整的小红书正文，200-500字，分段清晰，加 emoji，结尾加话题标签。`
      : '生成一篇家居软装主题的小红书正文，200-500字，分段清晰，加 emoji，结尾加话题标签。';
    const result = await callAi(userMsg);
    if (result) setBody(result.trim());
    setLoadingBody(false);
  }

  // ── AI 生成标签 ───────────────────────────────────────────────
  async function handleAiTags() {
    setLoadingTags(true);
    const context = title || body
      ? `标题：${title}\n正文摘要：${body.slice(0, 100)}`
      : '家居软装出租屋改造';
    const userMsg = `根据以下内容，生成 5-8 个适合小红书的话题标签，只输出不带#的标签词，用逗号分隔，不要其他内容：\n${context}`;
    const result = await callAi(userMsg);
    if (result) {
      const newTags = result
        .split(/[,，、\s]+/)
        .map((t) => t.trim().replace(/^#/, ''))
        .filter((t) => t.length > 0 && t.length < 20);
      setTags(newTags);
    }
    setLoadingTags(false);
  }

  async function handleSave(status?: string, silent = false) {
    await updateNote(noteId, { title, body, tags: JSON.stringify(tags), ...(status ? { status } : {}) });
    if (!silent) {
      Alert.alert('已保存', '', [{ text: '好', onPress: () => router.back() }]);
    }
  }

  function addTag() {
    // 支持空格/逗号分隔批量添加，自动去掉 # 前缀
    const raw = tagInput.trim();
    if (!raw) return;
    const newOnes = raw
      .split(/[,，、\s]+/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t.length > 0 && t.length < 20 && !tags.includes(t));
    if (newOnes.length > 0) setTags([...tags, ...newOnes]);
    setTagInput('');
  }

  if (!note) {
    return (
      <AuroraBackground style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: TText.secondary }}>草稿不存在</Text>
      </AuroraBackground>
    );
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <InlineNav
          title="编辑草稿"
          onBack={() => router.back()}
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <TouchableOpacity onPress={() => handleSave()}>
                <Text style={{ color: TText.secondary, fontSize: Font.body }}>保存</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Brand.red, paddingHorizontal: 12, paddingVertical: 5, borderRadius: Radius.pill }}
                onPress={async () => { await handleSave(undefined, true); router.push(`/(tabs)/create/publish?id=${note?.id}`); }}
              >
                <Text style={{ color: '#fff', fontSize: Font.footnote, fontWeight: Font.semibold }}>发布</Text>
                <Ionicons name="arrow-forward" size={12} color="#fff" />
              </TouchableOpacity>
            </View>
          }
        />

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* 关联图片 */}
          {linkedItems.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
              <View style={styles.imgRow}>
                {linkedItems.map((item, idx) => (
                  <View key={item.id} style={styles.thumbWrap}>
                    <PhImage uri={item.imagePath} style={styles.thumb} />
                    <View style={styles.thumbBadge}>
                      <Text style={styles.thumbBadgeText}>{idx + 1}</Text>
                    </View>
                    {item.analysis && (
                      <View style={styles.thumbAnalyzed}>
                        <Ionicons name="checkmark-circle" size={12} color="#22c55e" />
                      </View>
                    )}
                  </View>
                ))}
              </View>
            </ScrollView>
          )}

          {/* AI 对话入口 */}
          <TouchableOpacity
            style={styles.aiChatRow}
            onPress={() => router.push(`/(tabs)/create/chat?noteId=${noteId}`)}
            activeOpacity={0.75}
          >
            <BlurView intensity={20} tint="light" style={styles.aiChatBlur}>
              <View style={styles.aiChatBg} />
              <Text style={styles.aiChatText}>✦  AI 对话创作</Text>
              <Text style={styles.aiChatArrow}>›</Text>
            </BlurView>
          </TouchableOpacity>

          {/* ── 标题 ── */}
          <FieldHeader label="标题" onAi={handleAiTitle} loading={loadingTitle} />
          <BlurView intensity={15} tint="light" style={styles.fieldWrap}>
            <View style={styles.fieldBg} />
            <TextInput
              style={styles.titleInput}
              value={title}
              onChangeText={setTitle}
              placeholder="写下吸引人的标题…"
              placeholderTextColor={TText.tertiary}
              maxLength={50}
            />
          </BlurView>
          <Text style={styles.charCount}>{title.length}/50</Text>

          {/* ── 正文 ── */}
          <FieldHeader label="正文" onAi={handleAiBody} loading={loadingBody} />
          <BlurView intensity={15} tint="light" style={styles.fieldWrap}>
            <View style={styles.fieldBg} />
            <TextInput
              style={styles.bodyInput}
              value={body}
              onChangeText={setBody}
              placeholder="写下笔记内容…"
              placeholderTextColor={TText.tertiary}
              multiline
              textAlignVertical="top"
            />
          </BlurView>
          <Text style={styles.charCount}>{body.length} 字</Text>

          {/* ── 话题标签 ── */}
          <FieldHeader label="话题标签" onAi={handleAiTags} loading={loadingTags} />
          <View style={styles.tagRow}>
            {tags.map((t) => (
              <TouchableOpacity
                key={t}
                style={styles.tag}
                onPress={() => setTags(tags.filter((x) => x !== t))}
              >
                <Text style={styles.tagText}>#{t} ×</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.tagInputRow}>
            <BlurView intensity={15} tint="light" style={styles.tagInputWrap}>
              <View style={styles.fieldBg} />
              <TextInput
                style={styles.tagInputField}
                value={tagInput}
                onChangeText={setTagInput}
                placeholder="手动输入话题"
                placeholderTextColor={TText.tertiary}
                returnKeyType="done"
                onSubmitEditing={addTag}
              />
            </BlurView>
            <TouchableOpacity style={styles.tagAddBtn} onPress={addTag}>
              <Text style={styles.tagAddText}>添加</Text>
            </TouchableOpacity>
          </View>

          {frequentTags.length > 0 && (
            <View style={{ marginTop: 10, marginBottom: 8 }}>
              <Text style={styles.recentLabel}>常用标签</Text>
              <View style={styles.tagRow}>
                {frequentTags.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={styles.recentTag}
                    onPress={() => setTags([...tags, t])}
                  >
                    <Text style={styles.recentTagText}>#{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          <LiquidButton
            label="标记为待发布"
            onPress={() => handleSave('ready')}
            variant="success"
            style={{ marginTop: 32, marginBottom: 20, alignSelf: 'stretch' }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 60 },
  imgRow: { flexDirection: 'row', gap: 10 },
  thumb: { width: 76, height: 76, borderRadius: Radius.md },
  thumbWrap: { position: 'relative', width: 76, height: 76 },
  thumbBadge: {
    position: 'absolute', top: 4, left: 4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  thumbBadgeText: { fontSize: 10, color: '#fff', fontWeight: '700' },
  thumbAnalyzed: { position: 'absolute', bottom: 4, right: 4 },

  // ── AI 对话入口条 ───────────────────────────────────────────
  aiChatRow: {
    marginBottom: 24, borderRadius: Radius.lg, overflow: 'hidden',
    borderWidth: 0.5, borderColor: Brand.redMid,
  },
  aiChatBlur: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16, overflow: 'hidden',
  },
  aiChatBg: { ...StyleSheet.absoluteFill, backgroundColor: Brand.redSoft },
  aiChatText: { flex: 1, color: Brand.red, fontWeight: Font.semibold, fontSize: Font.body },
  aiChatArrow: { fontSize: 20, color: Brand.red },

  // ── 字段标题行 ──────────────────────────────────────────────
  fieldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    marginTop: 4,
  },
  fieldHeaderLabel: {
    fontSize: Font.footnote,
    fontWeight: Font.semibold,
    color: TText.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  // ── AI 小按钮 ───────────────────────────────────────────────
  aiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Brand.redSoft,
    borderWidth: 0.5,
    borderColor: Brand.redMid,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  aiBtnIcon: {
    fontSize: 11,
    color: Brand.red,
    lineHeight: 14,
  },
  aiBtnLabel: {
    fontSize: Font.caption,
    color: Brand.red,
    fontWeight: Font.semibold,
    letterSpacing: 0.3,
  },

  // ── 输入框 ──────────────────────────────────────────────────
  fieldWrap: {
    borderRadius: Radius.md, overflow: 'hidden',
    borderWidth: 0.5, borderColor: Glass.borderSoft, marginBottom: 4,
  },
  fieldBg: { ...StyleSheet.absoluteFill, backgroundColor: Glass.bg },
  titleInput: {
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: Font.title3, fontWeight: Font.semibold,
    color: TText.primary, minHeight: 48,
  },
  bodyInput: {
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: Font.body, color: TText.primary,
    minHeight: 200, lineHeight: 26,
  },
  charCount: { fontSize: Font.caption, color: TText.tertiary, textAlign: 'right', marginBottom: 20 },

  // ── 标签 ────────────────────────────────────────────────────
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  tag: {
    backgroundColor: Brand.redSoft, borderRadius: Radius.pill,
    paddingHorizontal: 12, paddingVertical: 5,
    borderWidth: 0.5, borderColor: Brand.redMid,
  },
  tagText: { color: Brand.red, fontSize: Font.footnote, fontWeight: Font.medium },
  tagInputRow: { flexDirection: 'row', gap: 8 },
  tagInputWrap: {
    flex: 1, borderRadius: Radius.pill, overflow: 'hidden',
    borderWidth: 0.5, borderColor: Glass.borderSoft,
  },
  tagInputField: { paddingHorizontal: 14, paddingVertical: 9, fontSize: Font.body, color: TText.primary },
  tagAddBtn: {
    paddingHorizontal: 16, justifyContent: 'center',
    borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Glass.border,
  },
  tagAddText: { color: TText.secondary, fontWeight: Font.medium, fontSize: Font.body },
  recentLabel: { fontSize: Font.caption, color: TText.tertiary, marginBottom: 8 },
  recentTag: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 0.5,
    borderColor: Glass.border,
    backgroundColor: '#fff',
  },
  recentTagText: { color: TText.secondary, fontSize: Font.footnote },
});
