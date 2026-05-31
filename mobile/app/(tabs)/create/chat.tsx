import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet,
  ActivityIndicator, Alert, ScrollView, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useRef, useEffect } from 'react';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useStore } from '../../../store';
import { chat, buildSystemPrompt, getApiKey, getAiConfig } from '../../../services/ai';
import { AuroraBackground, InlineNav, PhImage } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../utils/theme';
import Ionicons from '@expo/vector-icons/Ionicons';

type Message = { role: 'user' | 'assistant'; content: string };

// 快捷提示词
const QUICK_PROMPTS = [
  '帮我写一篇关于这张图的小红书笔记',
  '给我 5 个吸引眼球的标题',
  '用傲娇嘴硬的语气重写正文',
  '提炼卖点，写一段种草文案',
];

export default function ChatScreen() {
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const router = useRouter();
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const profile = useStore((s) => s.profile);
  const updateNote = useStore((s) => s.updateNote);
  const note = notes.find((n) => n.id === Number(noteId));
  const linkedItemIds: number[] = JSON.parse(note?.itemIds ?? '[]');
  const linkedItems = items.filter((i) => linkedItemIds.includes(i.id));

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const flatRef = useRef<FlatList>(null);

  // 检查 API Key
  useEffect(() => {
    (async () => {
      const config = await getAiConfig();
      const key = await getApiKey(config.providerId);
      setKeyMissing(!key);
    })();
  }, []);

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
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
    const userMsg: Message = { role: 'user', content };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const analyses = linkedItems.map((i) => i.analysis ?? '').filter(Boolean);
      const sys = buildSystemPrompt(
        {
          personaName: profile?.personaName,
          niche: profile?.niche,
          personaTone: profile?.personaTone,
          taboos: profile?.taboos,
        },
        analyses,
      );
      const reply = await chat(next, sys);
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (e: any) {
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
    const lines = content.split('\n').filter((l) => l.trim());
    const title = lines[0]?.replace(/^[#标题：\s]+/, '').trim() ?? '';
    const body = lines.slice(1).join('\n').trim();
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
          <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
            {item.content}
          </Text>
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
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <InlineNav
          title="AI 创作"
          onBack={() => router.back()}
          right={
            <TouchableOpacity onPress={() => router.push(`/(tabs)/create/edit/${noteId}`)}>
              <Text style={{ color: Brand.red, fontSize: Font.body }}>编辑</Text>
            </TouchableOpacity>
          }
        />

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
              {hasImages ? `${linkedItems.length} 张图` : '无图片'}
            </Text>
          </View>
          <View style={[styles.contextChip, hasAnalysis && styles.contextChipOn]}>
            <Ionicons name="analytics-outline" size={11} color={hasAnalysis ? Brand.red : TText.tertiary} />
            <Text style={[styles.contextChipText, hasAnalysis && styles.contextChipTextOn]}>
              {hasAnalysis ? 'AI 分析已注入' : '图片未分析'}
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
          keyExtractor={(_, i) => String(i)}
          renderItem={renderMessage}
          contentContainerStyle={styles.msgList}
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

        {/* 输入区 */}
        <BlurView intensity={65} tint="light" style={styles.inputBar}>
          <View style={styles.inputBarBg} />
          <View style={styles.inputRow}>
            <BlurView intensity={20} tint="light" style={styles.inputWrap}>
              <View style={styles.inputBg} />
              <TextInput
                style={styles.input}
                value={input}
                onChangeText={setInput}
                placeholder="告诉 AI 你想创作什么…"
                placeholderTextColor={TText.tertiary}
                multiline
                returnKeyType="send"
                onSubmitEditing={() => handleSend()}
              />
            </BlurView>
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnOff]}
              onPress={() => handleSend()}
              disabled={!input.trim() || loading}
            >
              {loading
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="arrow-up" size={18} color="#fff" />
              }
            </TouchableOpacity>
          </View>
        </BlurView>
      </KeyboardAvoidingView>
    </AuroraBackground>
  );
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

  msgList: { padding: 16, gap: 14, paddingBottom: 16, flexGrow: 1 },
  msgRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  msgRowUser: { justifyContent: 'flex-end' },
  msgRowAI: { justifyContent: 'flex-start' },
  aiAvatar: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: Brand.redSoft,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: Brand.redMid,
  },
  aiAvatarText: { fontSize: Font.caption, fontWeight: Font.bold, color: Brand.red },
  bubble: { maxWidth: '78%', borderRadius: Radius.lg, overflow: 'hidden', padding: 12 },
  bubbleUser: { borderWidth: 0.5, borderColor: 'rgba(255,80,100,0.3)' },
  bubbleAI: { borderWidth: 0.5, borderColor: Glass.border },
  bubbleAIBg: { ...StyleSheet.absoluteFill, backgroundColor: Glass.bg },
  bubbleText: { fontSize: Font.subheadline, color: TText.secondary, lineHeight: 22 },
  bubbleTextUser: { color: '#fff' },
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

  inputBar: { overflow: 'hidden', borderTopWidth: 0.5, borderTopColor: 'rgba(0,0,0,0.08)' },
  inputBarBg: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255,248,248,0.75)' },
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
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
