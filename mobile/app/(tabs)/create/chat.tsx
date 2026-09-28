import { Chip, GlassBackBar } from '../../../components/ui';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet,
  ActivityIndicator, Alert, ScrollView, Modal, Pressable,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useState, useRef, useEffect, useCallback } from 'react';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../../../store';
import { chatStream, buildSystemPrompt, getApiKey, getAiConfig } from '../../../services/ai';
import { buildMobileMemoryPrompt } from '../../../services/memory';
import { getImageAssetReference, readBase64FromUri } from '../../../services/media';
import * as ImagePicker from 'expo-image-picker';
import {
  listChatSessions, saveChatSession, deleteChatSession, newChatSessionId,
  type ChatSession,
} from '../../../services/chatHistory';
import { AuroraBackground, PhImage } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../utils/theme';
import { extractTitleAndBody, stripMarkdownForXhs, stripMarkdownForXhsTitle } from '../../../utils/xhsText';
import Ionicons from '@expo/vector-icons/Ionicons';

type Message = { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean };
type PendingImage = { uri: string; assetId?: string | null };

// 快捷提示词
const QUICK_PROMPTS = [
  '帮我写一篇关于这张图的小红书笔记',
  '给我 5 个吸引眼球的标题',
  '用傲娇嘴硬的语气重写正文',
  '提炼卖点，写一段种草文案',
];

export default function ChatScreen() {
  const { noteId, from } = useLocalSearchParams<{ noteId: string; from?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const profile = useStore((s) => s.profile);
  const updateNote = useStore((s) => s.updateNote);
  const recordAssetUse = useStore((s) => s.recordAssetUse);
  const markItemsUsed = useStore((s) => s.markItemsUsed);
  const note = notes.find((n) => n.id === Number(noteId));
  const linkedItemIds: number[] = JSON.parse(note?.itemIds ?? '[]');
  const linkedItems = items.filter((i) => linkedItemIds.includes(i.id));

  function handleBack() {
    // 清掉创作 Tab 栈里的对话页，再回到目标 Tab
    try {
      if (typeof router.dismissAll === 'function') router.dismissAll();
      else if (router.canGoBack()) router.back();
    } catch {}
    if (from === 'library') {
      router.navigate('/(tabs)/library');
      return;
    }
    router.navigate('/(tabs)/create');
  }

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const [sessionId, setSessionId] = useState<string>(() => newChatSessionId());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<ChatSession[]>([]);
  // 本轮要附带的图片（本地 uri）
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const flatRef = useRef<FlatList>(null);

  async function pickImages() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.85,
      base64: false,
    });
    if (res.canceled || !res.assets?.length) return;
    const selected = res.assets.map((asset) => ({ uri: asset.uri, assetId: asset.assetId }));
    setPendingImages((prev) => [...prev, ...selected].slice(0, 6));
  }

  // 会话写入本地（防抖）
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setTimeout(() => {
      void saveChatSession({
        id: sessionId,
        title: messages.find((m) => m.role === 'user')?.content?.slice(0, 24) ?? '未命名会话',
        noteId: note ? note.id : null,
        messages,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [messages, sessionId]);

  async function openHistory() {
    const list = await listChatSessions();
    setHistoryList(list);
    setHistoryOpen(true);
  }

  function loadSession(s: ChatSession) {
    setSessionId(s.id);
    setMessages(s.messages.map((m) => ({ ...m, streaming: false })));
    setHistoryOpen(false);
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 80);
  }

  function startNewChat() {
    setSessionId(newChatSessionId());
    setMessages([]);
    setHistoryOpen(false);
  }

  // 检查 API Key
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const config = await getAiConfig();
        const key = await getApiKey(config.providerId);
        if (!cancelled) setKeyMissing(!key);
      })();
      return () => { cancelled = true; };
    }, [])
  );

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if ((!content && pendingImages.length === 0) || loading) return;
    if (keyMissing) {
      Alert.alert(
        '未配置 AI Key',
        '请先在「设置 → AI 模型配置」中填写 API Key',
        [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ],
      );
      return;
    }
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: content || '（图片）',
    };
    const assistantId = `assistant-${Date.now()}`;
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const next: Message[] = [...messages, userMsg, assistantMsg];
    setMessages(next);
    setInput('');
    const sentImages = pendingImages;
    setPendingImages([]);
    setLoading(true);
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      const analyses = linkedItems.map((i) => i.analysis ?? '').filter(Boolean);
      const memoryBlock = await buildMobileMemoryPrompt('chat').catch(() => '');
      const sys = [
        buildSystemPrompt(
          {
            personaName: profile?.personaName,
            niche: profile?.niche,
            personaTone: profile?.personaTone,
            taboos: profile?.taboos,
          },
          analyses,
        ),
        memoryBlock,
      ].filter(Boolean).join('\n\n');
      // 关联素材 + 本轮添加的图片 → base64
      const imageBase64List: string[] = [];
      for (const item of linkedItems) {
        if (!item.imagePath) continue;
        try {
          const raw = await readBase64FromUri(item.imagePath);
          if (raw) imageBase64List.push(raw.replace(/^data:image\/[\w.+-]+;base64,/, ''));
        } catch {}
      }
      const usedImageRefs: Array<Promise<{ uri: string; sourceAssetId: string | null }>> = [];
      for (const image of sentImages) {
        try {
          const raw = await readBase64FromUri(image.uri);
          if (raw) {
            imageBase64List.push(raw.replace(/^data:image\/[\w.+-]+;base64,/, ''));
            usedImageRefs.push(getImageAssetReference(image.assetId, image.uri));
          }
        } catch {}
      }
      if (usedImageRefs.length > 0) {
        void Promise.all(usedImageRefs)
          .then((references) => recordAssetUse(
            references.map((reference) => ({
              imagePath: reference.uri,
              sourceAssetId: reference.sourceAssetId,
              title: '新图片',
            })),
            'ai_creation',
          ))
          .catch((error) => console.warn('record chat image use failed', error));
      }
      if (linkedItemIds.length > 0) {
        void markItemsUsed(linkedItemIds, 'ai_creation')
          .catch((error) => console.warn('mark linked chat images used failed', error));
      }
      const conversation = next
        .filter((message) => message.id !== assistantId)
        .map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.id === userMsg.id && imageBase64List.length > 0
            ? { images: imageBase64List }
            : {}),
        }));
      const reply = await chatStream(conversation, sys, (_delta, fullText) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, content: fullText, streaming: true }
              : message
          )
        );
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 0);
      });
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, content: reply, streaming: false }
            : message
        )
      );
    } catch (e: any) {
      setMessages((prev) => prev.filter((message) => message.id !== assistantId));
      const msg: string = e.message ?? '未知错误';
      if (msg.includes('API Key') || msg.includes('401') || msg.includes('403')) {
        Alert.alert('Key 无效或已过期', msg, [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ]);
      } else if (msg.includes('网络') || msg.includes('fetch') || msg.includes('Network')) {
        Alert.alert('网络错误', '请检查网络连接后重试');
      } else {
        Alert.alert('AI 回复失败', msg);
      }
    } finally {
      setLoading(false);
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  async function handleSave(content: string) {
    if (!note) return;
    const { title, body } = extractTitleAndBody(content);
    await updateNote(note.id, { title, body });
    Alert.alert('已保存到草稿', '', [
      { text: '去编辑', onPress: () => router.push(`/(tabs)/create/edit/${note?.id}`) },
      { text: '继续对话' },
    ]);
  }

  function renderMessage({ item }: { item: Message }) {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAI]}>
        {!isUser && (
          <View style={styles.aiAvatar}>
            <Text style={styles.aiAvatarText}>AI</Text>
          </View>
        )}
        <BlurView
          intensity={isUser ? 0 : 20}
          tint="light"
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}
        >
          {isUser && (
            <LinearGradient
              colors={['#FF2442', '#E8001E']}
              style={[StyleSheet.absoluteFill, { borderRadius: Radius.lg }]}
            />
          )}
          {!isUser && <View style={styles.bubbleAIBg} />}
          {isUser ? (
            <Text style={[styles.bubbleText, styles.bubbleTextUser]}>
              {item.content}
            </Text>
          ) : (
            <View>
              <MarkdownBubble content={item.content} />
              {item.streaming && !item.content ? (
                <View style={styles.streamingRow}>
                  <ActivityIndicator size="small" color={Brand.red} />
                  <Text style={styles.streamingText}>AI 正在生成…</Text>
                </View>
              ) : null}
            </View>
          )}
          {!isUser && (
            <TouchableOpacity style={styles.saveBtn} onPress={() => handleSave(item.content)}>
              <Text style={styles.saveBtnText}>保存到草稿 →</Text>
            </TouchableOpacity>
          )}
        </BlurView>
      </View>
    );
  }

  // 人设上下文摘要（展示给用户看注入了什么）
  const hasProfile = !!(profile?.personaName || profile?.personaTone);
  const hasImages = linkedItems.length > 0;
  const hasAnalysis = linkedItems.some((i) => i.analysis);

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <GlassBackBar
        title="AI 创作"
        backLabel="返回"
        onBack={handleBack}
        right={
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={() => void openHistory()}
            hitSlop={8}
            accessibilityLabel="历史会话"
          >
            <Ionicons name="time-outline" size={18} color={TText.primary} />
          </TouchableOpacity>
        }
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* API Key 未配置警告 */}
        {keyMissing && (
          <TouchableOpacity
            style={styles.keyWarning}
            onPress={() => router.push('/(tabs)/profile/ai-config')}
          >
            <Ionicons name="warning-outline" size={14} color="#b45309" />
            <Text style={styles.keyWarningText}>未配置 API Key，点此前往设置</Text>
            <Ionicons name="chevron-forward" size={14} color="#b45309" />
          </TouchableOpacity>
        )}

        {/* 上下文注入状态条 */}
        <View style={styles.contextBar}>
          <View style={[styles.contextChip, hasProfile && styles.contextChipOn]}>
            <Ionicons name="person-outline" size={11} color={hasProfile ? Brand.red : TText.tertiary} />
            <Text style={[styles.contextChipText, hasProfile && styles.contextChipTextOn]}>
              {hasProfile ? profile!.personaName ?? '人设' : '无人设'}
            </Text>
          </View>
          <View style={[styles.contextChip, hasImages && styles.contextChipOn]}>
            <Ionicons name="images-outline" size={11} color={hasImages ? Brand.red : TText.tertiary} />
            <Text style={[styles.contextChipText, hasImages && styles.contextChipTextOn]}>
              {hasImages ? `${linkedItems.length} 张图·将随消息发送` : '无图片'}
            </Text>
          </View>
          <View style={[styles.contextChip, hasAnalysis && styles.contextChipOn]}>
            <Ionicons name="analytics-outline" size={11} color={hasAnalysis ? Brand.red : TText.tertiary} />
            <Text style={[styles.contextChipText, hasAnalysis && styles.contextChipTextOn]}>
              {hasAnalysis ? 'AI 分析已注入' : '图将随消息发送'}
            </Text>
          </View>
        </View>

        {/* 关联图片条 */}
        {linkedItems.length > 0 && (
          <ScrollView
            horizontal
            style={styles.imgStrip}
            contentContainerStyle={styles.imgStripContent}
            showsHorizontalScrollIndicator={false}
          >
            {linkedItems.map((item) => (
              <PhImage key={item.id} uri={item.imagePath} style={styles.thumb} />
            ))}
          </ScrollView>
        )}

        <FlatList
          ref={flatRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.msgList, { paddingBottom: 96 + Math.max(insets.bottom, 12) }]}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>AI 创作助手</Text>
              <Text style={styles.emptySubtitle}>
                {hasProfile ? `以「${profile!.personaName ?? '博主'}」人设` : ''}
                {hasAnalysis ? '结合图片内容' : ''}为你生成小红书内容
              </Text>
              {/* 快捷提示词 */}
              <View style={styles.quickRow}>
                {QUICK_PROMPTS.map((q) => (
                  <TouchableOpacity
                    key={q}
                    style={styles.quickChip}
                    onPress={() => handleSend(q)}
                  >
                    <Text style={styles.quickChipText}>{q}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          }
        />

        {/* 本轮附加图片 */}
        {pendingImages.length > 0 && (
          <View style={styles.pendingStrip}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {pendingImages.map((image, i) => (
                <View key={`${image.uri}-${i}`} style={styles.pendingItem}>
                  <PhImage uri={image.uri} style={styles.pendingImg} />
                  <TouchableOpacity
                    style={styles.pendingDel}
                    hitSlop={6}
                    onPress={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Ionicons name="close" size={12} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* 输入区 */}
        <BlurView intensity={65} tint="light" style={styles.inputBar}>
          <View style={styles.inputBarBg} />
          <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <TouchableOpacity style={styles.pickBtn} onPress={() => void pickImages()} accessibilityLabel="添加图片">
              <Ionicons name="image-outline" size={22} color={Brand.red} />
            </TouchableOpacity>
            <BlurView intensity={20} tint="light" style={styles.inputWrap}>
              <View style={styles.inputBg} />
              <TextInput
                style={styles.input}
                value={input}
                onChangeText={setInput}
                placeholder={pendingImages.length ? '描述这组图，或直接发送…' : '告诉 AI 你想创作什么…'}
                placeholderTextColor={TText.tertiary}
                multiline
                returnKeyType="send"
                onSubmitEditing={() => handleSend()}
              />
            </BlurView>
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() && pendingImages.length === 0 || loading) && styles.sendBtnOff]}
              onPress={() => handleSend()}
              disabled={(!input.trim() && pendingImages.length === 0) || loading}
            >
              {loading
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="arrow-up" size={18} color="#fff" />
              }
            </TouchableOpacity>
          </View>
        </BlurView>
      </KeyboardAvoidingView>

      {/* 历史会话 */}
      <Modal
        visible={historyOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setHistoryOpen(false)}
      >
        <View style={styles.histOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setHistoryOpen(false)} />
          <View style={styles.histSheet}>
            <View style={styles.histHandle} />
            <View style={styles.histHeader}>
              <Text style={styles.histTitle}>历史会话</Text>
              <TouchableOpacity onPress={startNewChat} style={styles.histNewBtn}>
                <Ionicons name="add" size={14} color="#fff" />
                <Text style={styles.histNewText}>新对话</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 480 }} nestedScrollEnabled>
              {historyList.length === 0 ? (
                <Text style={styles.histEmpty}>暂无历史，发一条消息就会自动保存</Text>
              ) : (
                historyList.map((s) => (
                  <View key={s.id} style={styles.histRow}>
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      onPress={() => loadSession(s)}
                    >
                      <Text style={styles.histRowTitle} numberOfLines={1}>{s.title}</Text>
                      <Text style={styles.histRowMeta}>
                        {(s.updatedAt ?? '').slice(0, 16).replace('T', ' ')} · {s.messages.length} 条
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      hitSlop={8}
                      onPress={() => {
                        Alert.alert('删除会话', '确认删除该历史会话？', [
                          { text: '取消', style: 'cancel' },
                          {
                            text: '删除', style: 'destructive',
                            onPress: async () => {
                              await deleteChatSession(s.id);
                              setHistoryList((prev) => prev.filter((x) => x.id !== s.id));
                            },
                          },
                        ]);
                      }}
                    >
                      <Ionicons name="trash-outline" size={16} color={TText.tertiary} />
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </AuroraBackground>
  );
}

function MarkdownBubble({ content }: { content: string }) {
  const lines = content.split('\n');

  return (
    <View style={styles.markdownWrap}>
      {lines.map((line, index) => {
        const trimmed = line.trim();

        if (!trimmed) return <View key={`spacer-${index}`} style={styles.mdSpacer} />;
        if (/^---+$/.test(trimmed)) return <View key={`rule-${index}`} style={styles.mdRule} />;

        if (/^#\s+/.test(trimmed)) {
          return (
            <Text key={`h-${index}`} style={styles.mdHeading}>
              {trimmed.replace(/^#\s+/, '')}
            </Text>
          );
        }

        const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
        if (orderedMatch) {
          return (
            <View key={`ol-${index}`} style={styles.mdListRow}>
              <Text style={styles.mdListIndex}>{orderedMatch[1]}.</Text>
              <Text style={styles.mdParagraph}>{renderInlineMarkdown(orderedMatch[2])}</Text>
            </View>
          );
        }

        const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
        if (bulletMatch) {
          return (
            <View key={`ul-${index}`} style={styles.mdListRow}>
              <Text style={styles.mdListIndex}>•</Text>
              <Text style={styles.mdParagraph}>{renderInlineMarkdown(bulletMatch[1])}</Text>
            </View>
          );
        }

        return (
          <Text key={`p-${index}`} style={styles.mdParagraph}>
            {renderInlineMarkdown(trimmed)}
          </Text>
        );
      })}
    </View>
  );
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*.*?\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const isBold = part.startsWith('**') && part.endsWith('**');
    const value = isBold ? part.slice(2, -2) : part;
    return (
      <Text key={`${index}-${value}`} style={isBold ? styles.mdBold : undefined}>
        {value}
      </Text>
    );
  });
}

const styles = StyleSheet.create({
  keyWarning: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fef3c7',
    paddingVertical: 8, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#fcd34d',
  },
  keyWarningText: { flex: 1, fontSize: Font.footnote, color: '#b45309' },

  contextBar: {
    flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Glass.borderSubtle,
  },
  contextChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: Radius.pill, backgroundColor: '#f0f0f0',
  },
  contextChipOn: { backgroundColor: Brand.redSoft },
  contextChipText: { fontSize: 10, color: TText.tertiary },
  contextChipTextOn: { color: Brand.red, fontWeight: '600' },

  imgStrip: { maxHeight: 70, borderBottomWidth: 0.5, borderBottomColor: Glass.borderSubtle },
  imgStripContent: { padding: 10, gap: 8 },
  thumb: { width: 50, height: 50, borderRadius: Radius.md },

  msgList: { padding: 16, gap: 14, flexGrow: 1 },
  msgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  msgRowUser: { justifyContent: 'flex-end' },
  msgRowAI: { justifyContent: 'flex-start' },
  aiAvatar: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: Brand.redSoft,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: Brand.redMid,
    marginTop: 2,
  },
  aiAvatarText: { fontSize: Font.caption, fontWeight: Font.bold, color: Brand.red },
  bubble: { maxWidth: '78%', borderRadius: Radius.lg, overflow: 'hidden', padding: 12 },
  bubbleUser: { borderWidth: 0.5, borderColor: 'rgba(255,80,100,0.3)' },
  bubbleAI: { borderWidth: 0.5, borderColor: Glass.border },
  bubbleAIBg: { ...StyleSheet.absoluteFill, backgroundColor: Glass.bg },
  bubbleText: { fontSize: Font.subheadline, color: TText.secondary, lineHeight: 22 },
  bubbleTextUser: { color: '#fff' },
  markdownWrap: { gap: 0 },
  mdHeading: { fontSize: Font.callout, fontWeight: Font.bold, color: TText.primary, lineHeight: 24, marginBottom: 4 },
  mdParagraph: { fontSize: Font.subheadline, color: TText.secondary, lineHeight: 22, flex: 1 },
  mdBold: { fontWeight: Font.bold, color: TText.primary },
  mdRule: { height: 1, backgroundColor: Glass.border, marginVertical: 10 },
  mdSpacer: { height: 10 },
  mdListRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginBottom: 6 },
  mdListIndex: { width: 18, fontSize: Font.subheadline, color: TText.secondary, lineHeight: 22 },
  streamingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  streamingText: { fontSize: Font.caption, color: TText.tertiary },
  saveBtn: { marginTop: 8, alignSelf: 'flex-end' },
  saveBtnText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.medium },

  emptyWrap: { flex: 1, paddingTop: 40, paddingHorizontal: 24, alignItems: 'center' },
  emptyTitle: { fontSize: Font.title3, fontWeight: Font.bold, color: TText.primary, marginBottom: 6 },
  emptySubtitle: { fontSize: Font.subheadline, color: TText.tertiary, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  quickRow: { gap: 8, alignSelf: 'stretch' },
  quickChip: {
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: Radius.md, borderWidth: 0.5,
    borderColor: Glass.border, backgroundColor: Glass.bg,
  },
  quickChipText: { fontSize: Font.footnote, color: TText.secondary, lineHeight: 18 },

  historyBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  pendingStrip: {
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2,
  },
  pendingItem: {
    marginRight: 8,
  },
  pendingImg: {
    width: 56, height: 56, borderRadius: 8,
  } as any,
  pendingDel: {
    position: 'absolute', top: -4, right: -4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  pickBtn: {
    width: 38, height: 38,
    alignItems: 'center', justifyContent: 'center',
  },

  // 历史会话抽屉
  histOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  histSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28,
  },
  histHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: '#E4E4E7', alignSelf: 'center', marginBottom: 12,
  },
  histHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  histTitle: { fontSize: Font.title3, fontWeight: Font.bold, color: TText.primary },
  histNewBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Brand.red, borderRadius: Radius.pill,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  histNewText: { color: '#fff', fontSize: Font.caption, fontWeight: '600' },
  histEmpty: {
    padding: 24, textAlign: 'center',
    color: TText.tertiary, fontSize: Font.footnote,
  },
  histRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F0F0F0',
    gap: 12,
  },
  histRowTitle: { fontSize: Font.body, color: TText.primary, fontWeight: '500' },
  histRowMeta: { fontSize: Font.caption, color: TText.tertiary, marginTop: 2 },

  inputBar: { overflow: 'hidden', borderTopWidth: 0.5, borderTopColor: 'rgba(0,0,0,0.08)' },
  inputBarBg: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255,248,248,0.75)' },
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    alignItems: 'flex-end',
  },
  inputWrap: { flex: 1, borderRadius: Radius.xl, overflow: 'hidden', borderWidth: 0.5, borderColor: Glass.borderSoft },
  inputBg: { ...StyleSheet.absoluteFill, backgroundColor: Glass.bg },
  input: {
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: Font.body, color: TText.primary, maxHeight: 100,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Brand.red,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnOff: { backgroundColor: Brand.redSoft },
});
