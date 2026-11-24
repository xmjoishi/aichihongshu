import { GlassBackBar, LiquidButton, PhImage } from '../../../../components/ui';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, Pressable,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, ActivityIndicator, Modal,
  Dimensions, Image,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { useStore } from '../../../../store';
import { chatStream, getApiKey, getAiConfig } from '../../../../services/ai';
import { buildComposePromptSnapshot, type ComposePromptSnapshot } from '../../../../services/composePrompt';
import { getImageAssetReference, readBase64FromUri } from '../../../../services/media';
import { AuroraBackground } from '../../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../../utils/theme';
import { extractTitleAndBody, stripMarkdownForXhs, stripMarkdownForXhsTitle } from '../../../../utils/xhsText';
import Ionicons from '@expo/vector-icons/Ionicons';

const TITLE_MAX = 20;
const BODY_MAX = 1000;
const PROMPT_MAX = 5000;
const AI_IDLE_TIMEOUT_MS = 120_000;
const AI_ACTION_LABELS: Record<AiGenerationAction, string> = {
  title: '标题',
  body: '正文',
  tags: '话题',
  all: '整篇笔记',
};
const titleChars = (value: string) => Array.from(value);
const limitTitle = (value: string) => titleChars(value).slice(0, TITLE_MAX).join('');
const THUMB = 120;
const THUMB_GAP = 8;
const SCREEN_W = Dimensions.get('window').width;

type DraftPhoto = {
  key: string;
  imagePath: string;
  itemId?: number;
  assetId?: string | null;
};
type AiGenerationAction = 'title' | 'body' | 'tags' | 'all';
type GeneratedValues = { title: string; body: string; tags: string[] };
type GenerationChange = {
  status: 'pending' | 'adopted';
  action: AiGenerationAction;
  before: GeneratedValues;
  after: GeneratedValues;
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
  const [aiRulesVisible, setAiRulesVisible] = useState(false);
  const [aiRulesLoading, setAiRulesLoading] = useState(false);
  const [aiRulesError, setAiRulesError] = useState('');
  const [aiRulesSnapshot, setAiRulesSnapshot] = useState<ComposePromptSnapshot | null>(null);
  const [aiFailure, setAiFailure] = useState('');
  const [lastAiAction, setLastAiAction] = useState<AiGenerationAction | null>(null);
  const [generationChange, setGenerationChange] = useState<GenerationChange | null>(null);
  const [generationCompareVisible, setGenerationCompareVisible] = useState(false);
  const [aiPrompt, setAiPrompt] = useState(note?.generationPrompt ?? '');
  const [aiPromptSaveState, setAiPromptSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [aiPromptSaveError, setAiPromptSaveError] = useState('');
  const [aiPhase, setAiPhase] = useState('');
  const [aiPreview, setAiPreview] = useState('');
  const [aiElapsed, setAiElapsed] = useState(0);
  const aiRunning = useRef(false);
  const aiAbort = useRef<AbortController | null>(null);
  const aiTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiAbortReason = useRef<'user' | 'timeout' | null>(null);
  const aiPromptSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const aiPromptSaveVersion = useRef(0);
  const savedAiPrompt = useRef(note?.generationPrompt ?? '');
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const activeNoteId = useRef(noteId);
  activeNoteId.current = noteId;
  useFocusEffect(useCallback(() => {
    mounted.current = true;
    lifecycle.current += 1;
    aiRunning.current = false;
    setLoadingTitle(false);
    setLoadingBody(false);
    setLoadingTags(false);
    setLoadingAll(false);
    setAiPhase('');
    setAiPreview('');
    return () => {
      aiAbort.current?.abort();
      aiAbort.current = null;
      if (aiTimeout.current) clearTimeout(aiTimeout.current);
      aiTimeout.current = null;
      mounted.current = false;
      lifecycle.current += 1;
      aiRunning.current = false;
    };
  }, [noteId]));

  function requestGuard() {
    const owner = lifecycle.current;
    return () => mounted.current && activeNoteId.current === noteId && lifecycle.current === owner;
  }
  const aiBusy = loadingAll || loadingTitle || loadingBody || loadingTags;
  const [aiDrawerExpanded, setAiDrawerExpanded] = useState(false);
  const aiPromptInputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
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
      setAiPrompt(note.generationPrompt ?? '');
      savedAiPrompt.current = note.generationPrompt ?? '';
      aiPromptSaveVersion.current += 1;
      setAiPromptSaveState('saved');
      setAiPromptSaveError('');
      setTags(JSON.parse(note.tags ?? '[]'));
      setAiFailure('');
      setLastAiAction(null);
      aiAbortReason.current = null;
      setAiPromptVisible(false);
      setAiRulesVisible(false);
      setAiRulesLoading(false);
      setAiRulesError('');
      setAiRulesSnapshot(null);
      setGenerationChange(null);
      setGenerationCompareVisible(false);
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

  useEffect(() => {
    if (!aiBusy) return;
    setAiElapsed(0);
    const timer = setInterval(() => setAiElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [aiBusy]);

  async function saveAiPrompt(value: string) {
    const noteIdForSave = noteId;
    const version = ++aiPromptSaveVersion.current;
    setAiPromptSaveState('saving');
    setAiPromptSaveError('');
    const write = aiPromptSaveQueue.current
      .catch(() => {})
      .then(() => updateNote(noteIdForSave, { generationPrompt: value }));
    aiPromptSaveQueue.current = write;
    try {
      await write;
      if (version === aiPromptSaveVersion.current) {
        savedAiPrompt.current = value;
        setAiPromptSaveState('saved');
      }
    } catch (error: any) {
      if (version === aiPromptSaveVersion.current) {
        setAiPromptSaveState('error');
        setAiPromptSaveError(error?.message ?? '请重试保存');
      }
      throw error;
    }
  }

  async function flushAiPrompt() {
    await aiPromptSaveQueue.current;
    if (savedAiPrompt.current !== aiPrompt) await saveAiPrompt(aiPrompt);
  }

  function changeAiPrompt(value: string) {
    const next = Array.from(value).slice(0, PROMPT_MAX).join('');
    setAiPrompt(next);
    // Persist each edit in order so quickly typed later text cannot be overwritten by an older save.
    void saveAiPrompt(next).catch(() => {});
  }

  async function ensureDraftPhotosHydrated(isCurrent = () => true): Promise<DraftPhoto[]> {
    if (!note || hydratedNoteRef.current === note.id) return draftPhotos;
    const ids: number[] = JSON.parse(note.itemIds ?? '[]');
    if (ids.length === 0) {
      hydratedNoteRef.current = note.id;
      return draftPhotos;
    }
    await loadItems();
    if (!isCurrent()) throw new Error('生成已离开当前笔记');
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

  async function commitDraftPhotos(source: 'ai_creation' | 'note_attachment', isCurrent = () => true): Promise<DraftPhoto[]> {
    const currentPhotos = await ensureDraftPhotosHydrated(isCurrent);
    const references = await Promise.all(currentPhotos.map((photo) =>
      photo.itemId
        ? Promise.resolve({ uri: photo.imagePath, sourceAssetId: photo.assetId ?? null })
        : getImageAssetReference(photo.assetId, photo.imagePath)
    ));
    if (!isCurrent()) throw new Error('生成已离开当前笔记');
    const rows = await recordAssetUse(
      references.map((reference) => ({
        imagePath: reference.uri,
        sourceAssetId: reference.sourceAssetId,
        title: '新图片',
      })),
      source,
    );
    if (!isCurrent()) throw new Error('生成已离开当前笔记');
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

  function armAiTimeout(controller: AbortController) {
    if (aiTimeout.current) clearTimeout(aiTimeout.current);
    aiTimeout.current = setTimeout(() => {
      if (aiAbort.current !== controller) return;
      aiAbortReason.current = 'timeout';
      controller.abort();
    }, AI_IDLE_TIMEOUT_MS);
  }

  function cancelAiGeneration() {
    const controller = aiAbort.current;
    if (!controller) return;
    aiAbortReason.current = 'user';
    if (aiTimeout.current) clearTimeout(aiTimeout.current);
    aiTimeout.current = null;
    controller.abort();
  }

  async function callAi(userMsg: string): Promise<string | null> {
    if (aiRunning.current) return null;
    aiRunning.current = true;
    const controller = new AbortController();
    aiAbort.current = controller;
    aiAbortReason.current = null;
    setAiFailure('');
    armAiTimeout(controller);
    const isCurrent = requestGuard();
    setAiPreview('');
    setAiPhase('正在读取配置与主题');
    try {
      await flushAiPrompt();
      if (controller.signal.aborted) throw new Error('AI 请求已停止');
      const config = await getAiConfig();
      const key = await getApiKey(config.providerId);
      if (controller.signal.aborted) throw new Error('AI 请求已停止');
      if (!isCurrent()) return null;
      if (!key) {
        Alert.alert('未配置 API Key', '请先在「设置 → AI 模型配置」中填写 API Key', [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ]);
        return null;
      }
      if (!isCurrent()) return null;
      setAiPhase('正在准备图片与写作经验');
      const usedPhotos = await commitDraftPhotos('ai_creation', isCurrent);
      if (controller.signal.aborted) throw new Error('AI 请求已停止');
      const analyses = usedPhotos
        .map((photo) => items.find((item) => item.id === photo.itemId)?.analysis ?? '')
        .filter(Boolean);
      // 关联图片进多模态请求，让出稿真正结合画面
      const images: string[] = [];
      for (const photo of usedPhotos.slice(0, 6)) {
        if (controller.signal.aborted) throw new Error('AI 请求已停止');
        if (!photo.imagePath) continue;
        try {
          const raw = await readBase64FromUri(photo.imagePath);
          if (controller.signal.aborted) throw new Error('AI 请求已停止');
          if (raw) images.push(raw.replace(/^data:image\/\w+;base64,/, ''));
        } catch {}
      }
      if (controller.signal.aborted) throw new Error('AI 请求已停止');
      if (!isCurrent()) return null;
      const promptSnapshot = await buildComposePromptSnapshot({
        profile,
        analyses,
        theme: aiPrompt,
        taskPrompt: userMsg,
        hasImages: images.length > 0,
      });
      if (controller.signal.aborted) throw new Error('AI 请求已停止');
      if (!isCurrent()) return null;
      setAiPhase('已发送，等待 AI 输出');
      armAiTimeout(controller);
      const result = await chatStream(
        [{ role: 'user', content: promptSnapshot.userPrompt, ...(images.length > 0 ? { images } : {}) }],
        promptSnapshot.systemPrompt,
        (_delta, fullText) => {
          if (!isCurrent()) return;
          armAiTimeout(controller);
          setAiPhase('正在生成');
          setAiPreview(fullText);
        },
        { signal: controller.signal },
      );
      return isCurrent() ? result : null;
    } catch (e: any) {
      if (!isCurrent()) return null;
      const reason = aiAbortReason.current;
      const msg: string = reason === 'timeout'
        ? '长时间没有收到生成响应，已自动停止。可以重试，原稿已保留。'
        : reason === 'user'
          ? '已取消生成，原稿已保留。'
          : e.message ?? '未知错误';
      setAiFailure(msg);
      if (reason) return null;
      if (msg.includes('401') || msg.includes('403') || msg.includes('Key')) {
        Alert.alert('Key 无效', msg, [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ]);
      } else {
        Alert.alert('AI 生成失败', msg);
      }
      return null;
    } finally {
      if (aiAbort.current === controller) {
        if (aiTimeout.current) clearTimeout(aiTimeout.current);
        aiTimeout.current = null;
        aiAbort.current = null;
      }
      if (isCurrent()) {
        aiRunning.current = false;
        setAiPhase('');
      }
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

  function fullNoteTaskPrompt(): string {
    return (
      `${imageHint() || '结合本篇主题与已有素材。'}一次写出完整小红书笔记（发布文案本体，不是聊天），严格按下面格式纯文本输出：\n` +
      `第一行：标题（尽量18–20字且不超过20字，信息不足时不凑字）\n\n` +
      `空一行后写正文：根据素材决定篇幅，不超过1000字，保留关键细节，分段清晰，适量 emoji，不要 Markdown，不要「标题：」前缀，不要重复标题或额外套话。\n` +
      `正文最后另起一行，用空格分隔 5-8 个 #话题标签`
    );
  }

  async function openComposeRules() {
    setAiPromptVisible(false);
    setAiRulesSnapshot(null);
    setAiRulesError('');
    setAiRulesVisible(true);
    setAiRulesLoading(true);
    const isCurrent = requestGuard();
    try {
      const currentPhotos = await ensureDraftPhotosHydrated(isCurrent);
      const analyses = currentPhotos
        .map((photo) => items.find((item) => item.id === photo.itemId)?.analysis ?? '')
        .filter(Boolean);
      const snapshot = await buildComposePromptSnapshot({
        profile,
        analyses,
        theme: aiPrompt,
        taskPrompt: fullNoteTaskPrompt(),
        hasImages: currentPhotos.length > 0,
      });
      if (!isCurrent()) return;
      setAiRulesSnapshot(snapshot);
    } catch (error: any) {
      if (isCurrent()) setAiRulesError(error?.message ?? '读取本次规则失败，请重试');
    } finally {
      if (isCurrent()) setAiRulesLoading(false);
    }
  }

  function stageGeneratedChange(action: AiGenerationAction, updates: Partial<GeneratedValues>) {
    const before: GeneratedValues = { title, body, tags: [...tags] };
    const after: GeneratedValues = { ...before, ...updates, tags: updates.tags ? [...updates.tags] : before.tags };
    setGenerationChange({ status: 'pending', action, before, after });
    setGenerationCompareVisible(true);
  }

  function adoptGeneratedChange() {
    if (!generationChange) return;
    setTitle(generationChange.after.title);
    setBody(generationChange.after.body);
    setTags([...generationChange.after.tags]);
    setGenerationChange({ ...generationChange, status: 'adopted' });
    setGenerationCompareVisible(false);
  }

  function undoGeneratedChange() {
    if (!generationChange) return;
    if (generationChange.status === 'adopted') {
      setTitle(generationChange.before.title);
      setBody(generationChange.before.body);
      setTags([...generationChange.before.tags]);
    }
    setGenerationChange(null);
    setGenerationCompareVisible(false);
  }

  function clearGenerationChange() {
    if (!generationChange) return;
    setGenerationChange(null);
    setGenerationCompareVisible(false);
  }

  async function handleAiTitle() {
    const isCurrent = requestGuard();
    setLastAiAction('title');
    setAiFailure('');
    setLoadingTitle(true);
    const userMsg = body
      ? `${imageHint()}根据以下正文，写一个小红书标题，尽量18–20字且不超过${TITLE_MAX}字，信息不足时不凑字，只输出标题本身这一行（不要 Markdown、不要「标题：」前缀）：\n${body}`
      : `${imageHint() || '结合本篇主题与已有素材。'}写一个小红书标题，尽量18–20字且不超过${TITLE_MAX}字，信息不足时不凑字，只输出标题本身这一行。`;
    const result = await callAi(userMsg);
    if (isCurrent() && result) stageGeneratedChange('title', { title: limitTitle(stripMarkdownForXhsTitle(result)) });
    if (isCurrent()) setLoadingTitle(false);
  }

  async function handleAiBody() {
    const isCurrent = requestGuard();
    setLastAiAction('body');
    setAiFailure('');
    setLoadingBody(true);
    const userMsg = title
      ? `${imageHint()}根据标题「${title}」写小红书正文（发布文案本体，不是聊天）。根据素材决定篇幅，不超过1000字，保留关键细节，分段清晰，适量 emoji。只输出正文纯文本：禁止 Markdown、禁止「标题：」、保留用户原有语气，避免额外套话，不要重复标题。`
      : `${imageHint() || '结合本篇主题与已有素材。'}写一篇小红书正文（发布文案本体，不是聊天）。根据素材决定篇幅，不超过1000字，保留关键细节，分段清晰，适量 emoji。只输出正文纯文本：禁止 Markdown、禁止「标题：」、保留用户原有语气，避免额外套话。`;
    const result = await callAi(userMsg);
    if (isCurrent() && result) {
      stageGeneratedChange('body', { body: stripMarkdownForXhs(result).slice(0, BODY_MAX) });
    }
    if (isCurrent()) setLoadingBody(false);
  }

  async function handleAiTags() {
    const isCurrent = requestGuard();
    setLastAiAction('tags');
    setAiFailure('');
    setLoadingTags(true);
    const context = title || body
      ? `标题：${title}\n正文摘要：${body.slice(0, 100)}`
      : aiPrompt || '根据本篇图片与用户资料';
    const userMsg = `${imageHint()}根据以下内容，生成 5-8 个适合小红书的话题标签，只输出不带#的标签词，用逗号分隔，不要其他内容：\n${context}`;
    const result = await callAi(userMsg);
    if (isCurrent() && result) {
      const newTags = result
        .split(/[,，、\s]+/)
        .map((t) => t.trim().replace(/^#/, ''))
        .filter((t) => t.length > 0 && t.length < 20);
      stageGeneratedChange('tags', { tags: newTags });
    }
    if (isCurrent()) setLoadingTags(false);
  }

  /** 一键生成：标题 + 正文 + 话题，一次 AI 调用 */
  async function handleAiAll() {
    const isCurrent = requestGuard();
    setLastAiAction('all');
    setAiFailure('');
    setLoadingAll(true);
    try {
      const userMsg = fullNoteTaskPrompt();
      const result = await callAi(userMsg);
      if (!isCurrent() || !result) return;
      const { title: t, body: b } = extractTitleAndBody(result);
      const nextTitle = t || limitTitle(stripMarkdownForXhsTitle(result));
      let nextBody = b || stripMarkdownForXhs(result);
      let nextTags = [...tags];

      // 正文末尾的 #话题 抽到标签区（发布时会再拼回去）
      const tagMatches = [...nextBody.matchAll(/#([^\s#]{1,20})/g)].map((m) => m[1]);
      if (tagMatches.length > 0) {
        const uniq = Array.from(new Set(tagMatches)).slice(0, 12);
        nextTags = uniq;
        nextBody = nextBody.replace(/#([^\s#]{1,20})/g, '').replace(/\n{3,}/g, '\n\n').trim();
      }
      stageGeneratedChange('all', {
        title: limitTitle(nextTitle),
        body: nextBody.slice(0, BODY_MAX),
        tags: nextTags,
      });
    } finally {
      if (isCurrent()) setLoadingAll(false);
    }
  }

  function retryLastAiAction() {
    setAiFailure('');
    if (lastAiAction === 'title') void handleAiTitle();
    else if (lastAiAction === 'body') void handleAiBody();
    else if (lastAiAction === 'tags') void handleAiTags();
    else if (lastAiAction === 'all') void handleAiAll();
  }

  function openAiAllDrawer() {
    setAiPromptVisible(true);
  }

  async function handleSave(silent = true) {
    try {
      await flushAiPrompt();
      const trackedPhotos = await commitDraftPhotos('note_attachment');
      await updateNote(noteId, {
        title: limitTitle(stripMarkdownForXhsTitle(title)),
        body: stripMarkdownForXhs(body).slice(0, BODY_MAX),
        generationPrompt: aiPrompt,
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
    try { await flushAiPrompt(); }
    catch (error: any) { Alert.alert('主题保存失败', error?.message ?? '请重试'); return; }
    const hasContent =
      aiPrompt.trim().length > 0 ||
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
    if (aiBusy) return;
    const raw = tagInput.trim();
    if (!raw) return;
    const newOnes = raw
      .split(/[,，、\s]+/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t.length > 0 && t.length < 20 && !tags.includes(t));
    if (newOnes.length > 0) {
      clearGenerationChange();
      setTags([...tags, ...newOnes]);
    }
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
  const generationComparisonRows = generationChange
    ? (generationChange.action === 'all'
        ? ['title', 'body', 'tags'] as const
        : [generationChange.action] as const)
        .map((field) => ({
          label: field === 'title' ? '标题' : field === 'body' ? '正文' : '话题',
          before: field === 'tags' ? generationChange.before.tags.map((tag) => `#${tag}`).join(' ') : generationChange.before[field],
          after: field === 'tags' ? generationChange.after.tags.map((tag) => `#${tag}`).join(' ') : generationChange.after[field],
        }))
    : [];

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

          {aiBusy && (
            <View style={styles.generationPanel} accessibilityLiveRegion="polite">
              <View style={styles.aiGenerationHeader}>
                <View style={styles.fieldRight}>
                  <ActivityIndicator size="small" color={Brand.red} />
                  <Text style={styles.aiDrawerHint}>{aiPhase || '准备生成'} · {aiElapsed} 秒</Text>
                </View>
                <TouchableOpacity style={styles.aiCancelButton} onPress={cancelAiGeneration} accessibilityRole="button">
                  <Text style={styles.aiCancelText}>取消生成</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.aiDrawerVoiceHint}>无响应超过 120 秒会自动停止；完成后填入笔记，生成期间保留原稿。</Text>
              {aiPreview ? <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
                <Text selectable style={styles.aiDrawerHint}>{aiPreview}</Text>
              </ScrollView> : null}
            </View>
          )}
          {!!aiFailure && !aiBusy && (
            <View style={styles.aiFailurePanel} accessibilityLiveRegion="polite">
              <Text style={styles.aiFailureText}>{aiFailure}</Text>
              {lastAiAction && (
                <TouchableOpacity style={styles.aiRetryButton} onPress={retryLastAiAction} accessibilityRole="button">
                  <Ionicons name="refresh" size={14} color={Brand.red} />
                  <Text style={styles.aiRetryText}>重试</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          {generationChange && !aiBusy && (
            <View style={styles.generationReviewPanel} accessibilityLiveRegion="polite">
              <View style={{ flex: 1 }}>
                <Text style={styles.generationReviewTitle}>
                  {generationChange.status === 'pending' ? 'AI 结果待采用' : `已采用${AI_ACTION_LABELS[generationChange.action]}生成结果`}
                </Text>
                <Text style={styles.aiDrawerVoiceHint}>可对照生成前内容；采用后仍可撤销。</Text>
              </View>
              <TouchableOpacity onPress={() => setGenerationCompareVisible(true)} style={styles.aiRetryButton} accessibilityRole="button">
                <Text style={styles.aiRetryText}>对比</Text>
              </TouchableOpacity>
              {generationChange.status === 'adopted' && (
                <TouchableOpacity onPress={undoGeneratedChange} style={styles.aiRetryButton} accessibilityRole="button">
                  <Text style={styles.aiRetryText}>撤销</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* 标题 */}
          <View style={styles.field}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>标题</Text>
              <View style={styles.fieldRight}>
                <Text style={styles.count}>{titleChars(title).length}/{TITLE_MAX}</Text>
                <AiGhost onPress={() => void handleAiTitle()} loading={aiBusy} />
              </View>
            </View>
            <TextInput
              style={styles.titleInput}
              value={title}
              editable={!aiBusy}
              onChangeText={(v) => {
                clearGenerationChange();
                setTitle(limitTitle(v));
              }}
              placeholder="填写标题会有更多赞哦～"
              placeholderTextColor={TText.quaternary}
            />
          </View>

          {/* 正文 */}
          <View style={styles.field}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>正文</Text>
              <View style={styles.fieldRight}>
                <Text style={styles.count}>{body.length}/{BODY_MAX}</Text>
                <AiGhost onPress={() => void handleAiBody()} loading={aiBusy} />
              </View>
            </View>
            <TextInput
              style={styles.bodyInput}
              value={body}
              editable={!aiBusy}
              onChangeText={(v) => {
                clearGenerationChange();
                setBody(v.slice(0, BODY_MAX));
              }}
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
              <AiGhost onPress={() => void handleAiTags()} loading={aiBusy} />
            </View>
            <View style={styles.tagRow}>
              {tags.map((t) => (
                <TouchableOpacity disabled={aiBusy} key={t} onPress={() => { clearGenerationChange(); setTags(tags.filter((x) => x !== t)); }} style={styles.tagChip}>
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
                editable={!aiBusy}
                onSubmitEditing={addTag}
                placeholder="添加话题"
                placeholderTextColor={TText.quaternary}
                returnKeyType="done"
              />
              <TouchableOpacity disabled={aiBusy} onPress={addTag} style={styles.tagAddBtn}>
                <Text style={styles.tagAddText}>添加</Text>
              </TouchableOpacity>
            </View>
            {tagSuggestions.length > 0 && (
              <View style={styles.tagRow}>
                {tagSuggestions.map((t) => (
                  <TouchableOpacity
                    key={t}
                    disabled={aiBusy}
                    onPress={() => {
                      clearGenerationChange();
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
            disabled={aiBusy}
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
                <View style={styles.aiRulesEntry}>
                  <Text style={styles.aiRulesEntryLabel}>查看本次实际使用的规则与组合提示词</Text>
                  <TouchableOpacity
                    style={styles.aiRulesEntryButton}
                    onPress={() => void openComposeRules()}
                    accessibilityRole="button"
                  >
                    <Ionicons name="reader-outline" size={15} color={Brand.red} />
                    <Text style={styles.aiRulesEntryButtonText}>本次规则</Text>
                  </TouchableOpacity>
                </View>
                <Pressable onPress={() => aiPromptInputRef.current?.focus()}>
                  <TextInput
                    ref={aiPromptInputRef}
                    style={[styles.aiDrawerInput, aiDrawerExpanded && { minHeight: 180 }]}
                    value={aiPrompt}
                    onChangeText={changeAiPrompt}
                    placeholder="例如：突出出租屋改造的预算和收纳细节"
                    placeholderTextColor={TText.quaternary}
                    multiline
                    autoFocus
                    textAlignVertical="top"
                    blurOnSubmit={false}
                  />
                </Pressable>
                <Text style={styles.aiDrawerVoiceHint}>
                  {Array.from(aiPrompt).length}/{PROMPT_MAX} · {
                    aiPromptSaveState === 'saving' ? '主题保存中…' : aiPromptSaveState === 'error' ? '主题保存失败' : '主题已保存'
                  }，重新生成时继续使用。语音可使用键盘上的 🎤 系统听写
                </Text>
                {aiPromptSaveState === 'error' && (
                  <View style={styles.aiRulesEntry}>
                    <Text style={styles.aiPromptSaveError}>{aiPromptSaveError}</Text>
                    <TouchableOpacity onPress={() => void saveAiPrompt(aiPrompt).catch(() => {})} accessibilityRole="button">
                      <Text style={styles.aiPromptRetryText}>重试保存</Text>
                    </TouchableOpacity>
                  </View>
                )}
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
                    disabled={aiBusy}
                    onPress={() => {
                      setAiDrawerExpanded(false);
                      setAiPromptVisible(false);
                      void handleAiAll();
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

        <Modal
          visible={aiRulesVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            setAiRulesVisible(false);
            setAiPromptVisible(true);
          }}
        >
          <View style={styles.aiRulesOverlay}>
            <View style={styles.aiRulesCard}>
              <View style={styles.aiRulesHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.aiRulesTitle}>本次规则</Text>
                  <Text style={styles.aiRulesSubtitle}>读取手机当前配置与本篇主题</Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    setAiRulesVisible(false);
                    setAiPromptVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="返回主题编辑"
                  hitSlop={8}
                >
                  <Ionicons name="close" size={22} color={TText.secondary} />
                </TouchableOpacity>
              </View>
              {aiRulesLoading ? (
                <View style={styles.aiRulesLoading}>
                  <ActivityIndicator color={Brand.red} />
                  <Text style={styles.aiRulesLoadingText}>正在读取当前人设与启用经验…</Text>
                </View>
              ) : aiRulesError ? (
                <View style={styles.aiRulesErrorBox}>
                  <Text style={styles.aiRulesErrorText}>读取失败：{aiRulesError}</Text>
                  <Text style={styles.aiRulesErrorHint}>生成也会检查经验读取状态，不会静默跳过。</Text>
                </View>
              ) : aiRulesSnapshot ? (
                <ScrollView style={styles.aiRulesScroll} contentContainerStyle={styles.aiRulesContent}>
                  <Text style={styles.aiRulesSectionTitle}>生成端</Text>
                  <Text style={styles.aiRulesText}>
                    {aiRulesSnapshot.clientLabel} · {aiRulesSnapshot.providerLabel} · {aiRulesSnapshot.modelLabel}\n接口主机：{aiRulesSnapshot.endpointLabel}
                  </Text>

                  <Text style={styles.aiRulesSectionTitle}>账号人设</Text>
                  <Text style={styles.aiRulesText}>{aiRulesSnapshot.personaPrompt}</Text>

                  <Text style={styles.aiRulesSectionTitle}>当前主题</Text>
                  <Text style={styles.aiRulesText}>{aiRulesSnapshot.theme || '未填写主题'}</Text>

                  <Text style={styles.aiRulesSectionTitle}>本次启用经验与已确认记忆</Text>
                  <Text style={styles.aiRulesText}>{aiRulesSnapshot.experiencePrompt || '当前没有适用于出稿的用户经验或已确认事实记忆'}</Text>

                  <Text style={styles.aiRulesSectionTitle}>完整组合提示词</Text>
                  <Text selectable style={styles.aiRulesPromptText}>{aiRulesSnapshot.combinedPrompt}</Text>
                  <Text style={styles.aiRulesPrivacyHint}>API Key 不会显示在此处。</Text>
                </ScrollView>
              ) : null}
            </View>
          </View>
        </Modal>

        <Modal
          visible={generationCompareVisible && !!generationChange}
          transparent
          animationType="fade"
          onRequestClose={() => setGenerationCompareVisible(false)}
        >
          <View style={styles.generationCompareOverlay}>
            <View style={styles.generationCompareCard}>
              <View style={styles.aiRulesHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.aiRulesTitle}>对比 AI {generationChange ? AI_ACTION_LABELS[generationChange.action] : ''}</Text>
                  <Text style={styles.aiRulesSubtitle}>
                    {generationChange?.status === 'pending' ? '原稿未改动，选择是否采用新结果' : '可以保留当前结果或撤销恢复原稿'}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setGenerationCompareVisible(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel="关闭对比">
                  <Ionicons name="close" size={22} color={TText.secondary} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.generationCompareScroll} contentContainerStyle={styles.generationCompareContent}>
                {generationComparisonRows.map((row) => (
                  <View key={row.label} style={styles.generationCompareRow}>
                    <Text style={styles.aiRulesSectionTitle}>{row.label}</Text>
                    <Text style={styles.generationCompareLabel}>生成前</Text>
                    <Text selectable style={styles.generationCompareValue}>{row.before || '（空）'}</Text>
                    <Text style={styles.generationCompareLabel}>AI 结果</Text>
                    <Text selectable style={styles.generationCompareValue}>{row.after || '（空）'}</Text>
                  </View>
                ))}
              </ScrollView>
              <View style={styles.generationCompareActions}>
                {generationChange?.status === 'pending' ? (
                  <>
                    <TouchableOpacity style={styles.aiDrawerCancel} onPress={undoGeneratedChange}>
                      <Text style={styles.aiDrawerCancelText}>撤销这次生成</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.aiDrawerGo} onPress={adoptGeneratedChange}>
                      <Text style={styles.aiDrawerGoText}>采用生成结果</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <TouchableOpacity style={styles.aiDrawerCancel} onPress={() => setGenerationCompareVisible(false)}>
                      <Text style={styles.aiDrawerCancelText}>保留当前结果</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.aiDrawerGo, styles.generationUndoButton]} onPress={undoGeneratedChange}>
                      <Text style={styles.aiDrawerGoText}>撤销并恢复原稿</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  generationPanel: { padding: 14, marginBottom: 18, gap: 8, borderRadius: 12, backgroundColor: Brand.redSoft },
  aiGenerationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  aiCancelButton: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: Radius.pill, backgroundColor: '#fff' },
  aiCancelText: { fontSize: Font.caption, color: TText.secondary, fontWeight: Font.medium },
  aiFailurePanel: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    padding: 12, marginBottom: 16, borderRadius: 12,
    backgroundColor: '#FFF1F0', borderWidth: StyleSheet.hairlineWidth, borderColor: '#FECACA',
  },
  aiFailureText: { flex: 1, fontSize: Font.caption, lineHeight: 18, color: Brand.red },
  aiRetryButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 7 },
  aiRetryText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.semibold },
  generationReviewPanel: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    padding: 12, marginBottom: 14, borderRadius: 12,
    backgroundColor: '#FFF8E8', borderWidth: StyleSheet.hairlineWidth, borderColor: '#FDE68A',
  },
  generationReviewTitle: { fontSize: Font.footnote, fontWeight: Font.semibold, color: TText.primary },
  generationCompareOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 18, backgroundColor: 'rgba(0,0,0,0.45)',
  },
  generationCompareCard: {
    width: '100%', maxHeight: '88%', backgroundColor: '#fff',
    borderRadius: 18, overflow: 'hidden', paddingTop: 18,
  },
  generationCompareScroll: { flexShrink: 1 },
  generationCompareContent: { padding: 18, gap: 16 },
  generationCompareRow: { gap: 6 },
  generationCompareLabel: { marginTop: 5, fontSize: Font.caption, color: TText.tertiary },
  generationCompareValue: {
    fontSize: Font.footnote, color: TText.secondary, lineHeight: 20,
    padding: 10, borderRadius: 9, backgroundColor: '#F7F7F8',
  },
  generationCompareActions: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingBottom: 16, paddingTop: 8 },
  generationUndoButton: { backgroundColor: Brand.red },
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
  aiRulesEntry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  aiRulesEntryLabel: { flex: 1, fontSize: Font.caption, color: TText.secondary },
  aiRulesEntryButton: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: Radius.pill,
    backgroundColor: Brand.redSoft,
  },
  aiRulesEntryButtonText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.semibold },
  aiDrawerInput: {
    minHeight: 88, maxHeight: 140,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#E4E4E7',
    borderRadius: 12, padding: 12,
    fontSize: Font.body, color: TText.primary,
    textAlignVertical: 'top', backgroundColor: '#FAFAFA',
  },
  aiDrawerVoiceHint: { fontSize: Font.caption, color: TText.tertiary },
  aiPromptSaveError: { flex: 1, fontSize: Font.caption, color: Brand.red },
  aiPromptRetryText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.semibold },
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
  aiRulesOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 18, backgroundColor: 'rgba(0,0,0,0.45)',
  },
  aiRulesCard: {
    width: '100%', maxHeight: '88%', backgroundColor: '#fff',
    borderRadius: 18, overflow: 'hidden', paddingTop: 18,
  },
  aiRulesHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Glass.border,
  },
  aiRulesTitle: { fontSize: Font.title3, fontWeight: Font.bold, color: TText.primary },
  aiRulesSubtitle: { marginTop: 3, fontSize: Font.caption, color: TText.tertiary },
  aiRulesScroll: { flexShrink: 1 },
  aiRulesContent: { padding: 18, gap: 8 },
  aiRulesSectionTitle: { marginTop: 8, fontSize: Font.footnote, fontWeight: Font.semibold, color: TText.primary },
  aiRulesText: { fontSize: Font.caption, color: TText.secondary, lineHeight: 19 },
  aiRulesPromptText: {
    fontSize: 12, color: TText.secondary, lineHeight: 18,
    padding: 12, borderRadius: 10, backgroundColor: '#F7F7F8',
  },
  aiRulesPrivacyHint: { marginTop: 8, fontSize: Font.caption, color: TText.tertiary, textAlign: 'center' },
  aiRulesLoading: { minHeight: 160, justifyContent: 'center', alignItems: 'center', gap: 10 },
  aiRulesLoadingText: { fontSize: Font.footnote, color: TText.secondary },
  aiRulesErrorBox: { padding: 18, gap: 8 },
  aiRulesErrorText: { fontSize: Font.footnote, color: Brand.red },
  aiRulesErrorHint: { fontSize: Font.caption, color: TText.secondary },

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
