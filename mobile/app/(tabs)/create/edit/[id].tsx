import { GlassBackBar, LiquidButton, PhImage } from '../../../../components/ui';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, Pressable,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, ActivityIndicator, Modal,
  Dimensions, Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { useStore } from '../../../../store';
import { chat, buildSystemPrompt, getApiKey, getAiConfig } from '../../../../services/ai';
import { buildMobileMemoryPrompt } from '../../../../services/memory';
import { getImageAssetReference, readBase64FromUri } from '../../../../services/media';
import { AuroraBackground } from '../../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../../utils/theme';
import { extractTitleAndBody, stripMarkdownForXhs, stripMarkdownForXhsTitle } from '../../../../utils/xhsText';
import Ionicons from '@expo/vector-icons/Ionicons';

const TITLE_MAX = 20;
const BODY_MAX = 1000;
const THUMB = 120;
const THUMB_GAP = 8;
const SCREEN_W = Dimensions.get('window').width;

type DraftPhoto = {
  key: string;
  imagePath: string;
  itemId?: number;
  assetId?: string | null;
};

/** 幽灵 AI 小钮 */
function AiGhost({ onPress, loading }: { onPress: () => void; loading?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={loading} style={styles.aiGhost} hitSlop={6}>
      {loading ? <ActivityIndicator size={11} color={Brand.red} /> : <Text style={styles.aiGhostText}>✦ AI</Text>}
    </TouchableOpacity>
  );
}

/** 图条缩略图：长按拖动排序（拖动时其他图让位）、右上角删除、首图封面角标 */
function DraggableThumb({
  item, index, count, onMove, onRemove, onPress,
  dragFromSV, dragToSV, dragTxSV,
}: {
  item: { id: string | number; imagePath: string };
  index: number; count: number;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onPress: () => void;
  dragFromSV: SharedValue<number>;
  dragToSV: SharedValue<number>;
  dragTxSV: SharedValue<number>;
}) {
  const scale = useSharedValue(1);
  const dragging = useSharedValue(0);

  const pan = Gesture.Pan()
    .activateAfterLongPress(180)
    .onStart(() => {
      dragging.value = 1;
      scale.value = withTiming(1.1, { duration: 120 });
      dragFromSV.value = index;
      dragToSV.value = index;
      dragTxSV.value = 0;
    })
    .onUpdate((e) => {
      dragTxSV.value = e.translationX;
      const step = THUMB + THUMB_GAP;
      const target = Math.min(count - 1, Math.max(0, index + Math.round(e.translationX / step)));
      dragToSV.value = target;
    })
    .onEnd(() => {
      const to = dragToSV.value;
      if (to !== index) runOnJS(onMove)(index, to);
      dragFromSV.value = -1;
      dragToSV.value = -1;
      dragTxSV.value = 0;
      scale.value = withTiming(1, { duration: 120 });
      dragging.value = 0;
    });

  const tap = Gesture.Tap().onEnd(() => {
    runOnJS(onPress)();
  });

  const aStyle = useAnimatedStyle(() => {
    const step = THUMB + THUMB_GAP;
    const from = dragFromSV.value;
    const to = dragToSV.value;
    let shift = 0;
    if (index !== from && from >= 0 && to >= 0) {
      // 其他图按插入位让位（小红书式）
      if (from < to && index > from && index <= to) shift = -step;
      if (from > to && index >= to && index < from) shift = step;
    }
    const tx = index === from ? dragTxSV.value : 0;
    return {
      transform: [
        { translateX: tx + shift },
        { scale: index === from ? scale.value : 1 },
      ],
      zIndex: index === from ? 20 : 1,
      opacity: index === from ? 0.96 : 1,
    };
  });

  return (
    <Animated.View style={[styles.thumbWrap, aStyle]}>
      <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
        <View style={styles.thumbGestureArea}>
          <PhImage uri={item.imagePath} style={styles.thumb} />
          {index === 0 && (
            <View style={styles.coverChip}>
              <Text style={styles.coverChipText}>封面</Text>
            </View>
          )}
        </View>
      </GestureDetector>
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => onRemove(index)}
        hitSlop={8}
      >
        <Ionicons name="close" size={13} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function EditNoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const noteId = Number(id);
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const loadItems = useStore((s) => s.loadItems);
  const profile = useStore((s) => s.profile);
  const updateNote = useStore((s) => s.updateNote);
  const deleteNote = useStore((s) => s.deleteNote);
  const recordAssetUse = useStore((s) => s.recordAssetUse);
  const note = notes.find((n) => n.id === noteId);

  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [tags, setTags] = useState<string[]>(JSON.parse(note?.tags ?? '[]'));
  const [tagInput, setTagInput] = useState('');
  const [draftPhotos, setDraftPhotos] = useState<DraftPhoto[]>([]);
  const draftTouchedRef = useRef(false);
  const hydratedNoteRef = useRef<number | null>(null);

  const [loadingTitle, setLoadingTitle] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);
  const [loadingTags, setLoadingTags] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [notePreview, setNotePreview] = useState(false);
  const [coverPreview, setCoverPreview] = useState(false);
  const [npIndex, setNpIndex] = useState(0);
  const [loadingAll, setLoadingAll] = useState(false);
  const [aiPromptVisible, setAiPromptVisible] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiDrawerExpanded, setAiDrawerExpanded] = useState(false);
  const aiPromptInputRef = useRef<TextInput>(null);
  // 拖动排序共享值：让其他图实时让位
  const dragFromSV = useSharedValue(-1);
  const dragToSV = useSharedValue(-1);
  const dragTxSV = useSharedValue(0);

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
      draftTouchedRef.current = false;
      hydratedNoteRef.current = null;
    }
  }, [note?.id]);

  useEffect(() => {
    if (!note || hydratedNoteRef.current === note.id || draftTouchedRef.current) return;
    const ids: number[] = JSON.parse(note.itemIds ?? '[]');
    if (ids.length > 0 && items.length === 0) return;
    setDraftPhotos(ids.flatMap((itemId) => {
      const item = items.find((candidate) => candidate.id === itemId);
      return item
        ? [{ key: `item-${item.id}`, itemId: item.id, imagePath: item.imagePath, assetId: item.sourceAssetId }]
        : [];
    }));
    hydratedNoteRef.current = note.id;
  }, [note?.id, items]);

  async function ensureDraftPhotosHydrated(): Promise<DraftPhoto[]> {
    if (!note || hydratedNoteRef.current === note.id) return draftPhotos;
    const ids: number[] = JSON.parse(note.itemIds ?? '[]');
    if (ids.length === 0) {
      hydratedNoteRef.current = note.id;
      return draftPhotos;
    }
    await loadItems();
    const currentItems = useStore.getState().items;
    const existingPhotos = ids.flatMap((itemId) => {
      const item = currentItems.find((candidate) => candidate.id === itemId);
      return item
        ? [{ key: `item-${item.id}`, itemId: item.id, imagePath: item.imagePath, assetId: item.sourceAssetId }]
        : [];
    });
    const pendingPhotos = draftTouchedRef.current ? draftPhotos.filter((photo) => !photo.itemId) : [];
    const next = [...existingPhotos, ...pendingPhotos];
    setDraftPhotos(next);
    draftTouchedRef.current = pendingPhotos.length > 0;
    hydratedNoteRef.current = note.id;
    return next;
  }

  async function commitDraftPhotos(source: 'ai_creation' | 'note_attachment'): Promise<DraftPhoto[]> {
    const currentPhotos = await ensureDraftPhotosHydrated();
    const references = await Promise.all(currentPhotos.map((photo) =>
      photo.itemId
        ? Promise.resolve({ uri: photo.imagePath, sourceAssetId: photo.assetId ?? null })
        : getImageAssetReference(photo.assetId, photo.imagePath)
    ));
    const rows = await recordAssetUse(
      references.map((reference) => ({
        imagePath: reference.uri,
        sourceAssetId: reference.sourceAssetId,
        title: '新图片',
      })),
      source,
    );
    const next = currentPhotos.map((photo, index) => ({
      ...photo,
      key: `item-${rows[index].id}`,
      itemId: rows[index].id,
      imagePath: rows[index].imagePath,
      assetId: rows[index].sourceAssetId,
    }));
    draftTouchedRef.current = true;
    setDraftPhotos(next);
    return next;
  }

  async function callAi(userMsg: string): Promise<string | null> {
    const config = await getAiConfig();
    const key = await getApiKey(config.providerId);
    if (!key) {
      Alert.alert('未配置 API Key', '请先在「设置 → AI 模型配置」中填写 API Key', [
        { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
        { text: '取消', style: 'cancel' },
      ]);
      return null;
    }
    try {
      const usedPhotos = await commitDraftPhotos('ai_creation');
      const analyses = usedPhotos
        .map((photo) => items.find((item) => item.id === photo.itemId)?.analysis ?? '')
        .filter(Boolean);
      const memoryBlock = await buildMobileMemoryPrompt('compose').catch(() => '');
      const systemPrompt = [buildSystemPrompt(profile ?? {}, analyses), memoryBlock]
        .filter(Boolean)
        .join('\n\n');
      // 关联图片进多模态请求，让出稿真正结合画面
      const images: string[] = [];
      for (const photo of usedPhotos.slice(0, 6)) {
        if (!photo.imagePath) continue;
        try {
          const raw = await readBase64FromUri(photo.imagePath);
          if (raw) images.push(raw.replace(/^data:image\/\w+;base64,/, ''));
        } catch {}
      }
      return await chat(
        [{ role: 'user', content: userMsg, ...(images.length > 0 ? { images } : {}) }],
        systemPrompt,
      );
    } catch (e: any) {
      const msg: string = e.message ?? '未知错误';
      if (msg.includes('401') || msg.includes('403') || msg.includes('Key')) {
        Alert.alert('Key 无效', msg, [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ]);
      } else {
        Alert.alert('AI 生成失败', msg);
      }
      return null;
    }
  }

  function imageHint(): string {
    const imageCount = draftTouchedRef.current
      ? draftPhotos.length
      : draftPhotos.length || JSON.parse(note?.itemIds ?? '[]').length;
    return imageCount > 0
      ? `务必结合关联的 ${imageCount} 张图片画面内容（物品、颜色、风格、场景）来写，不要编造图里没有的东西。`
      : '';
  }

  async function handleAiTitle() {
    setLoadingTitle(true);
    const userMsg = body
      ? `${imageHint()}根据以下正文，写一个小红书标题，${TITLE_MAX}字以内，只输出标题本身这一行（不要 Markdown、不要「标题：」前缀）：\n${body}`
      : `${imageHint() || '家居软装主题。'}写一个家居软装小红书标题，${TITLE_MAX}字以内，只输出标题本身这一行。`;
    const result = await callAi(userMsg);
    if (result) setTitle(stripMarkdownForXhsTitle(result).slice(0, TITLE_MAX));
    setLoadingTitle(false);
  }

  async function handleAiBody() {
    setLoadingBody(true);
    const userMsg = title
      ? `${imageHint()}根据标题「${title}」写小红书正文（发布文案本体，不是聊天）。200-500字，分段清晰，加 emoji，结尾 5-8 个话题标签。只输出正文纯文本：禁止 Markdown、禁止「标题：」、禁止「谁懂啊/今天给大家分享」这类会话或过场，不要重复标题。`
      : `${imageHint() || '家居软装主题。'}写一篇家居软装小红书正文（发布文案本体，不是聊天）。200-500字，分段清晰，加 emoji，结尾 5-8 个话题标签。只输出正文纯文本：禁止 Markdown、禁止「标题：」、禁止「谁懂啊/今天给大家分享」这类会话或过场。`;
    const result = await callAi(userMsg);
    if (result) {
      const { body: cleaned } = extractTitleAndBody(result);
      setBody((cleaned || stripMarkdownForXhs(result)).slice(0, BODY_MAX));
    }
    setLoadingBody(false);
  }

  async function handleAiTags() {
    setLoadingTags(true);
    const context = title || body
      ? `标题：${title}\n正文摘要：${body.slice(0, 100)}`
      : '家居软装出租屋改造';
    const userMsg = `${imageHint()}根据以下内容，生成 5-8 个适合小红书的话题标签，只输出不带#的标签词，用逗号分隔，不要其他内容：\n${context}`;
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

  /** 一键生成：标题 + 正文 + 话题，一次 AI 调用 */
  async function handleAiAll(prompt?: string) {
    setLoadingAll(true);
    try {
      const focusHint = prompt?.trim()
        ? `这次生成必须围绕用户主题/提示词：「${prompt.trim()}」，不要跑偏。\n`
        : '';
      const userMsg =
        `${focusHint}${imageHint() || '家居软装主题。'}一次写出完整小红书笔记（发布文案本体，不是聊天），严格按下面格式纯文本输出：\n` +
        `第一行：标题（20字以内）\n\n` +
        `空一行后写正文：200-500字，分段清晰，用 emoji，不要 Markdown，不要「标题：」「谁懂啊/今天给大家分享」这类话，不要重复标题。\n` +
        `正文最后另起一行，用空格分隔 5-8 个 #话题标签`;
      const result = await callAi(userMsg);
      if (!result) return;
      const { title: t, body: b } = extractTitleAndBody(result);
      const nextTitle = t || stripMarkdownForXhsTitle(result).slice(0, TITLE_MAX);
      let nextBody = b || stripMarkdownForXhs(result);

      // 正文末尾的 #话题 抽到标签区（发布时会再拼回去）
      const tagMatches = [...nextBody.matchAll(/#([^\s#]{1,20})/g)].map((m) => m[1]);
      if (tagMatches.length > 0) {
        const uniq = Array.from(new Set(tagMatches)).slice(0, 12);
        setTags(uniq);
        nextBody = nextBody.replace(/#([^\s#]{1,20})/g, '').replace(/\n{3,}/g, '\n\n').trim();
      }
      setTitle(nextTitle.slice(0, TITLE_MAX));
      setBody(nextBody.slice(0, BODY_MAX));
    } finally {
      setLoadingAll(false);
    }
  }

  function openAiAllDrawer() {
    setAiPromptVisible(true);
  }

  async function handleSave(silent = true) {
    try {
      const trackedPhotos = await commitDraftPhotos('note_attachment');
      await updateNote(noteId, {
        title: stripMarkdownForXhsTitle(title).slice(0, TITLE_MAX),
        body: stripMarkdownForXhs(body).slice(0, BODY_MAX),
        tags: JSON.stringify(tags),
        itemIds: JSON.stringify(trackedPhotos.map((photo) => photo.itemId)),
      } as any);
      if (!silent) Alert.alert('已保存');
    } catch (e: any) {
      Alert.alert('保存失败', e?.message ?? String(e));
    }
  }

  /** 返回：不自动存草稿；空白草稿直接丢掉 */
  async function handleBack() {
    const hasContent =
      title.trim().length > 0 ||
      body.trim().length > 0 ||
      tags.length > 0 ||
      (draftTouchedRef.current ? draftPhotos.length > 0 : JSON.parse(note?.itemIds ?? '[]').length > 0);
    if (!hasContent) {
      await deleteNote(noteId).catch(() => {});
    }
    router.back();
  }

  const tagSuggestions = useMemo(() => {
    const kw = tagInput.trim().replace(/^#/, '');
    const pool = kw
      ? [...new Set([...frequentTags, ...notes.flatMap((n) => JSON.parse(n.tags ?? '[]') as string[])])]
          .filter((t) => t.includes(kw) && !tags.includes(t))
      : frequentTags;
    return pool.slice(0, 8);
  }, [frequentTags, tagInput, tags, notes]);

  function addTag() {
    const raw = tagInput.trim();
    if (!raw) return;
    const newOnes = raw
      .split(/[,，、\s]+/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t.length > 0 && t.length < 20 && !tags.includes(t));
    if (newOnes.length > 0) setTags([...tags, ...newOnes]);
    setTagInput('');
  }

  // ── 图条：长按拖动排序 / 右上角删除 / 首图即封面 / 点图预览 ──────
  const moveTo = useCallback((from: number, to: number) => {
    draftTouchedRef.current = true;
    setDraftPhotos((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [photo] = next.splice(from, 1);
      next.splice(to, 0, photo);
      return next;
    });
  }, []);
  function removeItem(index: number) {
    draftTouchedRef.current = true;
    setDraftPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  /** 删除图片需二次确认 */
  function confirmRemove(index: number, onDone?: (remain: number) => void) {
    Alert.alert('删除图片', '确定从本笔记移除这张图片？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          removeItem(index);
          onDone?.(orderedItems.length - 1);
        },
      },
    ]);
  }

  /** 先将照片 URI 放入草稿预览，保存笔记或实际用于 AI 时再建立照片记录。 */
  async function handleAddImages() {
    try {
      await ensureDraftPhotosHydrated();
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.9,
      });
      if (result.canceled || result.assets.length === 0) return;
      const added = result.assets.map((asset, index): DraftPhoto => ({
        key: `pending-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        imagePath: asset.uri,
        assetId: asset.assetId,
      }));
      draftTouchedRef.current = true;
      setDraftPhotos((prev) => {
        const seen = new Set(prev.map((photo) => photo.assetId || photo.imagePath));
        return [...prev, ...added.filter((photo) => {
          const identity = photo.assetId || photo.imagePath;
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        })];
      });
    } catch (e: any) {
      Alert.alert('添加图片失败', e?.message ?? String(e));
    }
  }

  if (!note) {
    return (
      <AuroraBackground style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <GlassBackBar title="编辑笔记" backLabel="返回" onBack={() => router.back()} />
        <Text style={{ color: TText.secondary }}>草稿不存在</Text>
      </AuroraBackground>
    );
  }

  const orderedItems = draftPhotos.map((photo) => ({
    id: photo.itemId ?? photo.key,
    imagePath: photo.imagePath,
  }));

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <GlassBackBar
          title="编辑笔记"
          backLabel="返回"
          onBack={() => void handleBack()}
          right={
            <TouchableOpacity onPress={() => void handleSave(false)}>
              <Text style={{ color: TText.secondary, fontSize: Font.footnote }}>存草稿</Text>
            </TouchableOpacity>
          }
        />

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* 图条：长按拖动排序，首图即封面，点首图看笔记预览 */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            <View style={styles.imgRow}>
              {orderedItems.map((item, idx) => (
                <DraggableThumb
                  key={item.id}
                  item={item}
                  index={idx}
                  count={orderedItems.length}
                  onMove={moveTo}
                  onRemove={(idx) => confirmRemove(idx)}
                  onPress={() => {
                    // 与小红书一致：点图进预览页，预览页内点图才放大
                    setNpIndex(idx);
                    setNotePreview(true);
                  }}
                  dragFromSV={dragFromSV}
                  dragToSV={dragToSV}
                  dragTxSV={dragTxSV}
                />
              ))}
              <TouchableOpacity style={styles.addThumb} onPress={() => void handleAddImages()}>
                <Ionicons name="add" size={28} color={TText.tertiary} />
                <Text style={styles.addThumbText}>加图</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          {/* 标题 */}
          <View style={styles.field}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>标题</Text>
              <View style={styles.fieldRight}>
                <Text style={styles.count}>{title.length}/{TITLE_MAX}</Text>
                <AiGhost onPress={() => void handleAiTitle()} loading={loadingTitle} />
              </View>
            </View>
            <TextInput
              style={styles.titleInput}
              value={title}
              onChangeText={(v) => setTitle(v.slice(0, TITLE_MAX))}
              placeholder="填写标题会有更多赞哦～"
              placeholderTextColor={TText.quaternary}
              maxLength={TITLE_MAX}
            />
          </View>

          {/* 正文 */}
          <View style={styles.field}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>正文</Text>
              <View style={styles.fieldRight}>
                <Text style={styles.count}>{body.length}/{BODY_MAX}</Text>
                <AiGhost onPress={() => void handleAiBody()} loading={loadingBody} />
              </View>
            </View>
            <TextInput
              style={styles.bodyInput}
              value={body}
              onChangeText={(v) => setBody(v.slice(0, BODY_MAX))}
              placeholder="写下笔记内容，分段清晰更容易被收藏～"
              placeholderTextColor={TText.quaternary}
              multiline
              textAlignVertical="top"
              maxLength={BODY_MAX}
            />
          </View>

          {/* 话题 */}
          <View style={styles.field}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>话题</Text>
              <AiGhost onPress={() => void handleAiTags()} loading={loadingTags} />
            </View>
            <View style={styles.tagRow}>
              {tags.map((t) => (
                <TouchableOpacity key={t} onPress={() => setTags(tags.filter((x) => x !== t))} style={styles.tagChip}>
                  <Text style={styles.tagChipText}>#{t}</Text>
                  <Ionicons name="close" size={11} color={Brand.red} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.tagInputRow}>
              <Text style={styles.hash}>#</Text>
              <TextInput
                style={styles.tagInput}
                value={tagInput}
                onChangeText={setTagInput}
                onSubmitEditing={addTag}
                placeholder="添加话题"
                placeholderTextColor={TText.quaternary}
                returnKeyType="done"
              />
              <TouchableOpacity onPress={addTag} style={styles.tagAddBtn}>
                <Text style={styles.tagAddText}>添加</Text>
              </TouchableOpacity>
            </View>
            {tagSuggestions.length > 0 && (
              <View style={styles.tagRow}>
                {tagSuggestions.map((t) => (
                  <TouchableOpacity
                    key={t}
                    onPress={() => {
                      setTags([...tags, t]);
                      setTagInput('');
                    }}
                    style={styles.tagGhost}
                  >
                    <Text style={styles.tagGhostText}>#{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          <View style={{ height: 24 }} />
        </ScrollView>

        {/* 底部工具栏：一键生成 + 发布准备 */}
        <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <TouchableOpacity
            style={styles.aiChatBtn}
            onPress={openAiAllDrawer}
            disabled={loadingAll}
          >
            {loadingAll
              ? <ActivityIndicator size="small" color={Brand.red} />
              : <Text style={styles.aiChatIcon}>✦</Text>
            }
            <Text style={styles.aiChatText}>{loadingAll ? '生成中…' : '一键生成'}</Text>
          </TouchableOpacity>
          <LiquidButton
            label="下一步 · 发布准备"
            variant="brand"
            style={{ flex: 1 }}
            onPress={async () => {
              await handleSave(true);
              await updateNote(noteId, { status: 'ready' } as any).catch(() => {});
              router.push(`/(tabs)/create/publish?id=${noteId}`);
            }}
          />
        </View>

        {/* 全屏看图 / 笔记预览 / 封面预览（同一 Modal 内按优先级切换，避免叠加不显示） */}
        <Modal
          visible={previewIndex !== null || notePreview || coverPreview}
          animationType="slide"
          onRequestClose={() => {
            if (previewIndex !== null) {
              setPreviewZoom(1);
              setPreviewIndex(null);
            } else if (coverPreview) {
              setCoverPreview(false);
            } else {
              setNotePreview(false);
            }
          }}
        >
          {previewIndex !== null ? (
          <View style={styles.previewOverlay}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              contentOffset={{ x: (previewIndex ?? 0) * SCREEN_W, y: 0 }}
              onMomentumScrollEnd={(e) => {
                // 已关闭时不再回写，避免 Modal 被“复活”
                if (previewIndex === null) return;
                const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
                if (i >= 0 && i < orderedItems.length) setPreviewIndex(i);
              }}
            >
              {orderedItems.map((item, i) => (
                <Pressable
                  key={item.id}
                  style={{ width: SCREEN_W, flex: 1 }}
                  onPress={() => setPreviewZoom((z) => (z === 1 ? 1.8 : 1))}
                >
                  <PhImage
                    uri={item.imagePath}
                    style={[styles.previewImage, previewZoom > 1 && { transform: [{ scale: previewZoom }] }]}
                    resizeMode="contain"
                  />
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.previewTopBar}>
              <Text style={styles.previewCount}>
                {((previewIndex ?? 0) + 1)} / {orderedItems.length}
              </Text>
              <TouchableOpacity onPress={() => { setPreviewZoom(1); setPreviewIndex(null); }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <Text style={styles.previewZoomHint}>
              {previewZoom > 1 ? '点按图片还原' : '点按图片放大 · 左右滑动切换'}
            </Text>
          </View>
          ) : !coverPreview ? (
          <View style={styles.notePreviewRoot}>
            <View style={[styles.npHeader, { paddingTop: insets.top + 8 }]}>
              <TouchableOpacity onPress={() => setNotePreview(false)} hitSlop={8}>
                <Ionicons name="chevron-back" size={24} color={TText.primary} />
              </TouchableOpacity>
              <View style={styles.npUser}>
                <Image source={require('../../../../assets/logo.png')} style={styles.npAvatarImg} />
                <Text style={styles.npUsername}>小红薯</Text>
              </View>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
              {/* 图片区：横滑 + 右下角编辑/删除（叠在图内） */}
              <View style={styles.npImageWrap}>
                <ScrollView
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  onMomentumScrollEnd={(e) =>
                    setNpIndex(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))
                  }
                >
                  {orderedItems.map((item, i) => (
                    <Pressable
                      key={item.id}
                      style={{ width: SCREEN_W, height: SCREEN_W * 1.1 }}
                      onPress={() => {
                        // 预览页内点图 → 放大
                        setPreviewIndex(i);
                      }}
                    >
                      <PhImage uri={item.imagePath} style={styles.npImage} />
                    </Pressable>
                  ))}
                </ScrollView>
                <View style={styles.npImgActions}>
                  <TouchableOpacity
                    style={styles.npEditImgBtn}
                    onPress={() => Alert.alert('编辑图片', '图片编辑能力后续支持，当前可在图条拖动排序或删除')}
                  >
                    <Ionicons name="create-outline" size={13} color="#fff" />
                    <Text style={styles.npEditImgText}>编辑图片</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.npDeleteImgBtn}
                    onPress={() => {
                      if (orderedItems.length === 0) return;
                      confirmRemove(npIndex, (remain) => {
                        if (remain <= 0) setNotePreview(false);
                        else if (npIndex >= remain) setNpIndex(remain - 1);
                      });
                    }}
                  >
                    <Ionicons name="trash-outline" size={15} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>

              {/* 切换圆点（图外，小红书式） */}
              {orderedItems.length > 1 && (
                <View style={styles.npDots}>
                  {orderedItems.map((_, i) => (
                    <View key={i} style={[styles.npDot, i === npIndex && styles.npDotActive]} />
                  ))}
                </View>
              )}

              <View style={styles.npTextBlock}>
                {title ? (
                  <Text style={styles.npTitle}>{stripMarkdownForXhsTitle(title)}</Text>
                ) : (
                  <Text style={styles.npTitlePh}>填写标题会有更多赞哦～</Text>
                )}
                <Text style={styles.npBody}>
                  {body ? stripMarkdownForXhs(body) : '写下笔记内容，分段清晰更容易被收藏～'}
                </Text>
                {tags.length > 0 && (
                  <Text style={styles.npTags}>
                    {tags.map((t) => `#${t}`).join(' ')}
                  </Text>
                )}
              </View>
            </ScrollView>

            <View style={[styles.npBottom, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <TouchableOpacity style={styles.npCoverBtn} onPress={() => setCoverPreview(true)}>
                <Text style={styles.npCoverBtnText}>预览封面</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.npNextBtn}
                onPress={async () => {
                  await handleSave(true);
                  await updateNote(noteId, { status: 'ready' } as any).catch(() => {});
                  setNotePreview(false);
                  router.push(`/(tabs)/create/publish?id=${noteId}`);
                }}
              >
                <Text style={styles.npNextBtnText}>发笔记</Text>
              </TouchableOpacity>
            </View>
          </View>
          ) : (
          <View style={styles.cvRoot}>
            <View style={[styles.cvHeader, { paddingTop: insets.top + 8 }]}>
              <TouchableOpacity onPress={() => setCoverPreview(false)} hitSlop={8} style={{ width: 40 }}>
                <Ionicons name="chevron-back" size={24} color={TText.primary} />
              </TouchableOpacity>
              <Text style={styles.cvHeaderTitle}>封面预览</Text>
              <View style={{ width: 40 }} />
            </View>
            <View style={styles.cvHintBar}>
              <Ionicons name="information-circle-outline" size={14} color={TText.tertiary} />
              <Text style={styles.cvHintText}>在这里预览首页、搜索等页面的封面效果</Text>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.cvFeed}>
              {/* 左列：本笔记卡片 + 骨架 */}
              <View style={styles.cvCol}>
                <View style={styles.cvCard}>
                  {orderedItems[0] ? (
                    <PhImage uri={orderedItems[0].imagePath} style={styles.cvCardImg} />
                  ) : (
                    <View style={[styles.cvCardImg, styles.cvSkeleton]} />
                  )}
                  <Text style={styles.cvCardTitle} numberOfLines={2}>
                    {stripMarkdownForXhsTitle(title) || '（无标题）'}
                  </Text>
                  <View style={styles.cvCardFooter}>
                    <View style={styles.cvCardUser}>
                      <Image source={require('../../../../assets/logo.png')} style={styles.cvCardAvatar} />
                      <Text style={styles.cvCardName} numberOfLines={1}>小红薯</Text>
                    </View>
                    <View style={styles.cvCardLike}>
                      <Ionicons name="heart-outline" size={13} color={TText.tertiary} />
                      <Text style={styles.cvCardLikeText}>赞</Text>
                    </View>
                  </View>
                </View>
                <View style={[styles.cvSkeletonCard, { height: 220 }]}>
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBarWide]} />
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBar]} />
                </View>
              </View>
              {/* 右列：骨架占位 */}
              <View style={styles.cvCol}>
                <View style={[styles.cvSkeletonCard, { height: 260 }]}>
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBarWide]} />
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBar]} />
                </View>
                <View style={[styles.cvSkeletonCard, { height: 160 }]}>
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBarWide]} />
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBar]} />
                </View>
                <View style={[styles.cvSkeletonCard, { height: 200 }]}>
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBarWide]} />
                  <View style={[styles.cvSkeleton, styles.cvSkeletonBar]} />
                </View>
              </View>
            </ScrollView>

            <View style={[styles.cvBottom, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <TouchableOpacity
                style={styles.cvPublishBtn}
                onPress={async () => {
                  await handleSave(true);
                  await updateNote(noteId, { status: 'ready' } as any).catch(() => {});
                  setCoverPreview(false);
                  setNotePreview(false);
                  router.push(`/(tabs)/create/publish?id=${noteId}`);
                }}
              >
                <Text style={styles.cvPublishText}>发笔记</Text>
              </TouchableOpacity>
            </View>
          </View>
          )}
        </Modal>

        {/* 一键生成：底部抽屉（可选主题提示词） */}
        <Modal
          visible={aiPromptVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setAiPromptVisible(false)}
        >
          <View style={styles.aiDrawerOverlay}>
            <Pressable style={{ flex: aiDrawerExpanded ? 0 : 1 }} onPress={() => setAiPromptVisible(false)} />
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
              <View style={[styles.aiDrawer, aiDrawerExpanded && styles.aiDrawerExpanded]}>
                <Pressable
                  style={styles.aiDrawerHandleWrap}
                  onPress={() => {
                    if (!aiDrawerExpanded) {
                      setAiDrawerExpanded(true);
                    } else {
                      aiPromptInputRef.current?.focus();
                    }
                  }}
                >
                  <View style={styles.aiDrawerHandle} />
                </Pressable>
                <Text style={styles.aiDrawerTitle}>一键生成</Text>
                <Text style={styles.aiDrawerHint}>
                  可补充这次要围绕的主题或提示词（图多时防跑偏）。不填也可以直接生成。点上方横杠可展开。
                </Text>
                <Pressable onPress={() => aiPromptInputRef.current?.focus()}>
                  <TextInput
                    ref={aiPromptInputRef}
                    style={[styles.aiDrawerInput, aiDrawerExpanded && { minHeight: 180 }]}
                    value={aiPrompt}
                    onChangeText={setAiPrompt}
                    placeholder="例如：突出出租屋改造的预算和收纳细节"
                    placeholderTextColor={TText.quaternary}
                    multiline
                    maxLength={300}
                    autoFocus
                    textAlignVertical="top"
                    blurOnSubmit={false}
                  />
                </Pressable>
                <Text style={styles.aiDrawerVoiceHint}>
                  语音：点输入框后用键盘上的 🎤 系统听写即可
                </Text>
                <View style={styles.aiDrawerActions}>
                  <TouchableOpacity
                    style={styles.aiDrawerCancel}
                    onPress={() => {
                      setAiDrawerExpanded(false);
                      setAiPromptVisible(false);
                    }}
                  >
                    <Text style={styles.aiDrawerCancelText}>取消</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.aiDrawerGo, loadingAll && { opacity: 0.6 }]}
                    disabled={loadingAll}
                    onPress={() => {
                      setAiDrawerExpanded(false);
                      setAiPromptVisible(false);
                      void handleAiAll(aiPrompt);
                    }}
                  >
                    {loadingAll
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={styles.aiDrawerGoText}>开始生成</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32 },
  imgRow: { flexDirection: 'row', gap: THUMB_GAP, paddingHorizontal: 2 },
  thumbWrap: {
    width: THUMB, height: THUMB,
    borderRadius: Radius.lg, overflow: 'hidden',
    backgroundColor: Glass.dark,
    position: 'relative',
  },
  thumbGestureArea: { width: '100%', height: '100%' },
  thumb: { width: '100%', height: '100%' },
  coverChip: {
    position: 'absolute', left: 8, bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: Radius.pill,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  coverChipText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  deleteBtn: {
    position: 'absolute', top: 6, right: 6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  previewOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
  },
  previewImage: {
    width: SCREEN_W, height: '100%',
  } as any,
  previewTopBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20,
  },
  previewCount: { color: '#fff', fontSize: Font.subheadline, fontWeight: '600' },
  previewZoomHint: {
    position: 'absolute', bottom: 36, left: 0, right: 0,
    textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: Font.caption,
  },
  previewClose: {
    position: 'absolute', top: 56, right: 20,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  addThumb: {
    width: THUMB, height: THUMB,
    borderRadius: Radius.lg,
    borderWidth: 1, borderStyle: 'dashed', borderColor: Glass.border,
    backgroundColor: Glass.dark,
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  addThumbText: { fontSize: Font.caption, color: TText.tertiary },

  // ── 笔记预览页（小红书信息流样式） ──
  notePreviewRoot: { flex: 1, backgroundColor: '#fff' },
  npHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee',
  },
  npUser: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  npAvatarImg: { width: 32, height: 32, borderRadius: 16 },
  npUsername: { fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary },
  npImage: { width: SCREEN_W, height: SCREEN_W * 1.1 } as any,
  npImageWrap: { position: 'relative' },
  npImgActions: {
    position: 'absolute', right: 14, bottom: 14,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  npEditImgBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: Radius.pill,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  npEditImgText: { color: '#fff', fontSize: Font.caption, fontWeight: Font.medium },
  npDeleteImgBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  npDots: {
    flexDirection: 'row', justifyContent: 'center', gap: 5,
    paddingVertical: 10,
  },
  npDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#ddd' },
  npDotActive: { backgroundColor: Brand.red },
  npTextBlock: { paddingHorizontal: 16, paddingTop: 14 },
  npTitle: { fontSize: 17, fontWeight: Font.bold, color: TText.primary, marginBottom: 8 },
  npTitlePh: { fontSize: 17, fontWeight: Font.bold, color: TText.quaternary, marginBottom: 8 },
  npBody: { fontSize: Font.body, color: TText.primary, lineHeight: 24 },
  npTags: { marginTop: 10, fontSize: Font.footnote, color: Brand.red, lineHeight: 22 },
  npBottom: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee',
    backgroundColor: '#fff',
  },
  npCoverBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12,
    borderRadius: Radius.pill, borderWidth: 1, borderColor: '#ddd',
  },
  npCoverBtnText: { fontSize: Font.body, color: TText.primary, fontWeight: Font.medium },
  npNextBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12,
    borderRadius: Radius.pill, backgroundColor: Brand.red,
  },
  npNextBtnText: { fontSize: Font.body, color: '#fff', fontWeight: Font.semibold },

  // ── 封面预览页（小红书信息流效果） ──
  cvRoot: { flex: 1, backgroundColor: '#fff' },
  cvHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee',
  },
  cvHeaderTitle: { fontSize: Font.body, fontWeight: Font.semibold, color: TText.primary },
  cvHintBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: '#f7f7f7',
  },
  cvHintText: { fontSize: Font.caption, color: TText.tertiary },
  cvFeed: {
    flexDirection: 'row', gap: 10, padding: 12,
  },
  cvCol: { flex: 1, gap: 10 },
  cvCard: {
    backgroundColor: '#fff', borderRadius: 10, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#eee',
  },
  cvCardImg: { width: '100%', aspectRatio: 3 / 4, backgroundColor: '#f0f0f0' } as any,
  cvCardTitle: {
    fontSize: Font.footnote, color: TText.primary, fontWeight: Font.medium,
    paddingHorizontal: 8, paddingTop: 8, lineHeight: 18,
  },
  cvCardFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingVertical: 8,
  },
  cvCardUser: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  cvCardAvatar: { width: 18, height: 18, borderRadius: 9 },
  cvCardName: { fontSize: 11, color: TText.tertiary, flexShrink: 1 },
  cvCardLike: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cvCardLikeText: { fontSize: 11, color: TText.tertiary },
  cvSkeletonCard: {
    backgroundColor: '#fff', borderRadius: 10, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#eee',
    padding: 10, justifyContent: 'flex-end', gap: 6,
  },
  cvSkeleton: { backgroundColor: '#ececec', borderRadius: 4 },
  cvSkeletonBarWide: { height: 12, width: '70%' },
  cvSkeletonBar: { height: 12, width: '45%' },
  cvBottom: {
    paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee',
    backgroundColor: '#fff',
  },
  cvPublishBtn: {
    alignItems: 'center', paddingVertical: 13,
    borderRadius: Radius.pill, backgroundColor: Brand.red,
  },
  cvPublishText: { fontSize: Font.body, color: '#fff', fontWeight: Font.semibold },

  field: { marginBottom: 18 },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  fieldLabel: { fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary },
  fieldRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  count: { fontSize: Font.caption, color: TText.tertiary },
  aiGhost: {
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: Radius.pill,
    borderWidth: 1, borderColor: Brand.redMid,
    backgroundColor: Brand.redSoft,
  },
  aiGhostText: { fontSize: 11, color: Brand.red, fontWeight: Font.semibold },

  aiAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Brand.red, borderRadius: Radius.lg,
    paddingVertical: 12, marginBottom: 16,
  },
  aiAllBtnBusy: { opacity: 0.75 },
  aiAllIcon: { color: '#fff', fontSize: 14, fontWeight: '700' },
  aiAllText: { color: '#fff', fontSize: Font.subheadline, fontWeight: Font.semibold },

  // ── 一键生成底部抽屉 ──
  aiDrawerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  aiDrawer: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 6, paddingBottom: 28,
    gap: 10,
  },
  aiDrawerExpanded: {
    maxHeight: '85%',
  },
  aiDrawerHandleWrap: {
    alignItems: 'center', paddingVertical: 8,
  },
  aiDrawerHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: '#E4E4E7',
  },
  aiDrawerTitle: { fontSize: Font.title3, fontWeight: Font.bold, color: TText.primary },
  aiDrawerHint: { fontSize: Font.footnote, color: TText.secondary, lineHeight: 18 },
  aiDrawerInput: {
    minHeight: 88, maxHeight: 140,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#E4E4E7',
    borderRadius: 12, padding: 12,
    fontSize: Font.body, color: TText.primary,
    textAlignVertical: 'top', backgroundColor: '#FAFAFA',
  },
  aiDrawerVoiceHint: { fontSize: Font.caption, color: TText.tertiary },
  aiDrawerActions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  aiDrawerCancel: {
    flex: 1, alignItems: 'center', paddingVertical: 13,
    borderRadius: 12, backgroundColor: '#F4F4F5',
  },
  aiDrawerCancelText: { fontSize: Font.body, fontWeight: Font.medium, color: TText.secondary },
  aiDrawerGo: {
    flex: 1, alignItems: 'center', paddingVertical: 13,
    borderRadius: 12, backgroundColor: Brand.red,
  },
  aiDrawerGoText: { fontSize: Font.body, fontWeight: Font.semibold, color: '#fff' },

  titleInput: {
    fontSize: Font.title3, fontWeight: Font.semibold, color: TText.primary,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Glass.border,
  },
  bodyInput: {
    fontSize: Font.body, color: TText.primary, lineHeight: 24,
    minHeight: 160,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Glass.border,
  },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  tagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Brand.redSoft, borderRadius: Radius.pill,
    paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: Brand.redMid,
  },
  tagChipText: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.medium },
  tagGhost: {
    backgroundColor: '#F4F4F5', borderRadius: Radius.pill,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  tagGhostText: { color: TText.secondary, fontSize: Font.caption },
  tagInputRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Glass.border,
    paddingHorizontal: 10,
  },
  hash: { color: TText.tertiary, fontSize: Font.body },
  tagInput: { flex: 1, paddingVertical: 10, fontSize: Font.subheadline, color: TText.primary },
  tagAddBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  tagAddText: { color: Brand.red, fontSize: Font.footnote, fontWeight: Font.semibold },

  bottomBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Glass.border,
    backgroundColor: Glass.bgStrong,
  },
  aiChatBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 11,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Brand.redMid,
    backgroundColor: Brand.redSoft,
  },
  aiChatIcon: { color: Brand.red, fontSize: 14 },
  aiChatText: { color: Brand.red, fontSize: Font.footnote, fontWeight: Font.semibold },
});
