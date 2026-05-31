import {
  View, Text, Image, ScrollView, TouchableOpacity,
  StyleSheet, Alert, TextInput, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useStore } from '../../../store';
import { resolveLocalUri, readBase64FromUri } from '../../../services/media';
import { analyzeImage } from '../../../services/ai';
import {
  AuroraBackground, LiquidCard, LiquidButton,
  InlineNav, SectionLabel,
} from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../utils/theme';
import Ionicons from '@expo/vector-icons/Ionicons';

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const itemId = Number(id);
  const items = useStore((s) => s.items);
  const notes = useStore((s) => s.notes);
  const deleteItem = useStore((s) => s.deleteItem);
  const addNote = useStore((s) => s.addNote);
  const updateItemAnalysis = useStore((s) => s.updateItemAnalysis);
  const updateItemTags = useStore((s) => s.updateItemTags);
  const item = items.find((i) => i.id === itemId);

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [tagInput, setTagInput] = useState('');

  const currentTags: string[] = JSON.parse(item?.tags ?? '[]');
  // 关联此图片的笔记
  const linkedNotes = notes.filter((n) => {
    try { return (JSON.parse(n.itemIds ?? '[]') as number[]).includes(itemId); }
    catch { return false; }
  });

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    resolveLocalUri(item.imagePath)
      .then((u) => { if (!cancelled) setImageUri(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item?.imagePath]);

  if (!item) {
    return (
      <AuroraBackground style={styles.center}>
        <Text style={{ color: TText.secondary, fontSize: Font.body }}>图片不存在</Text>
      </AuroraBackground>
    );
  }

  async function handleAnalyze() {
    if (!item) return;
    setAnalyzing(true);
    try {
      const b64 = await readBase64FromUri(item.imagePath);
      const result = await analyzeImage(b64);
      await updateItemAnalysis(item.id, result);
    } catch (e: any) {
      const msg: string = e.message ?? '未知错误';
      if (msg.includes('MiniMax') || msg.includes('Key')) {
        Alert.alert('需要 MiniMax API Key', '图片分析需要 MiniMax Key，请在「设置 → AI 模型配置」中填写', [
          { text: '去配置', onPress: () => router.push('/(tabs)/profile/ai-config') },
          { text: '取消', style: 'cancel' },
        ]);
      } else {
        Alert.alert('分析失败', msg);
      }
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleDelete() {
    Alert.alert('删除图片', '确认从图库中删除此图片？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive',
        onPress: async () => {
          await deleteItem(itemId);
          router.back();
        },
      },
    ]);
  }

  async function handleCreateNote() {
    const note = await addNote({ itemIds: [itemId] });
    router.push(`/(tabs)/create/edit/${note.id}`);
  }

  function addTag() {
    const raw = tagInput.trim();
    if (!raw) return;
    const newOnes = raw
      .split(/[,，、\s]+/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t.length > 0 && t.length < 20 && !currentTags.includes(t));
    if (newOnes.length > 0) updateItemTags(item!.id, [...currentTags, ...newOnes]);
    setTagInput('');
  }

  function removeTag(tag: string) {
    updateItemTags(item!.id, currentTags.filter((t) => t !== tag));
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <InlineNav
        title=""
        onBack={() => router.back()}
        right={
          <TouchableOpacity onPress={handleDelete}>
            <Text style={{ color: Brand.red, fontSize: Font.body }}>删除</Text>
          </TouchableOpacity>
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* 全宽主图 */}
        <View style={styles.heroWrap}>
          <Image source={{ uri: imageUri ?? undefined }} style={styles.heroImg} resizeMode="cover" />
          <LinearGradient
            colors={['transparent', 'rgba(30,10,15,0.65)']}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.heroMeta}>
            <Text style={styles.heroTitle}>{item.title}</Text>
            <Text style={styles.heroDate}>{item.createdAt?.slice(0, 10)}</Text>
          </View>
        </View>

        <View style={styles.content}>
          {/* AI 分析卡片 */}
          <LiquidCard style={{ marginBottom: 16 }}>
            <View style={styles.sectionHeader}>
              <SectionLabel>AI 分析</SectionLabel>
              <TouchableOpacity
                style={styles.reanalyzeBtn}
                onPress={handleAnalyze}
                disabled={analyzing}
              >
                {analyzing
                  ? <ActivityIndicator size="small" color={Brand.red} />
                  : <Ionicons name="refresh-outline" size={14} color={Brand.red} />
                }
                <Text style={styles.reanalyzeBtnText}>
                  {analyzing ? '分析中…' : item.analysis ? '重新分析' : '立即分析'}
                </Text>
              </TouchableOpacity>
            </View>
            {item.analysis
              ? <Text style={styles.analysisText}>{item.analysis}</Text>
              : (
                <Text style={styles.analysisEmpty}>
                  点击「立即分析」让 AI 识别图片内容，用于创作时的上下文注入
                </Text>
              )
            }
          </LiquidCard>

          {/* 标签卡片 */}
          <LiquidCard style={{ marginBottom: 16 }}>
            <SectionLabel>标签</SectionLabel>
            <View style={styles.tagRow}>
              {currentTags.map((tag) => (
                <TouchableOpacity
                  key={tag}
                  style={styles.tagChip}
                  onPress={() => removeTag(tag)}
                >
                  <Text style={styles.tagChipText}>#{tag}</Text>
                  <Ionicons name="close" size={11} color={Brand.red} style={{ marginLeft: 3 }} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.tagInputRow}>
              <BlurView intensity={15} tint="light" style={styles.tagInputWrap}>
                <View style={styles.tagInputBg} />
                <TextInput
                  style={styles.tagInput}
                  value={tagInput}
                  onChangeText={setTagInput}
                  placeholder="添加标签，逗号分隔"
                  placeholderTextColor={TText.tertiary}
                  onSubmitEditing={addTag}
                  returnKeyType="done"
                />
              </BlurView>
              <TouchableOpacity style={styles.tagAddBtn} onPress={addTag}>
                <Ionicons name="add" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          </LiquidCard>

          {/* 关联笔记 */}
          {linkedNotes.length > 0 && (
            <LiquidCard style={{ marginBottom: 16 }}>
              <SectionLabel>{`关联笔记（${linkedNotes.length}）`}</SectionLabel>
              {linkedNotes.map((n) => (
                <TouchableOpacity
                  key={String(n.id)}
                  style={styles.noteRow}
                  onPress={() => router.push(`/(tabs)/create/edit/${n.id}`)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.noteTitle} numberOfLines={1}>
                      {n.title || '（无标题）'}
                    </Text>
                    <Text style={styles.noteStatus}>
                      {n.status === 'published' ? '已发布' : n.status === 'archived' ? '已归档' : '草稿'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={TText.tertiary} />
                </TouchableOpacity>
              ))}
            </LiquidCard>
          )}

          <LiquidButton
            label="用这张图创作笔记"
            onPress={handleCreateNote}
            size="lg"
            style={{ alignSelf: 'stretch' }}
          />
        </View>
      </ScrollView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroWrap: { width: '100%', height: 360, position: 'relative' },
  heroImg: { width: '100%', height: '100%' },
  heroMeta: { position: 'absolute', bottom: 20, left: 20, right: 20 },
  heroTitle: { fontSize: Font.title2, fontWeight: Font.bold, color: '#fff', marginBottom: 4 },
  heroDate: { fontSize: Font.caption, color: 'rgba(255,255,255,0.6)' },
  content: { padding: 20, paddingBottom: 60 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  reanalyzeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 10, borderRadius: Radius.pill, backgroundColor: Brand.redSoft },
  reanalyzeBtnText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.medium },

  analysisText: { fontSize: Font.body, color: TText.secondary, lineHeight: 26 },
  analysisEmpty: { fontSize: Font.footnote, color: TText.tertiary, lineHeight: 22, fontStyle: 'italic' },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  tagChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.pill, backgroundColor: Brand.redSoft, borderWidth: 0.5, borderColor: Brand.redMid },
  tagChipText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.medium },
  tagInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  tagInputWrap: { flex: 1, borderRadius: Radius.lg, overflow: 'hidden', borderWidth: 0.5, borderColor: Glass.borderSoft },
  tagInputBg: { ...StyleSheet.absoluteFill, backgroundColor: Glass.bg },
  tagInput: { paddingHorizontal: 12, paddingVertical: 8, fontSize: Font.footnote, color: TText.primary },
  tagAddBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Brand.red, alignItems: 'center', justifyContent: 'center' },

  noteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Glass.borderSubtle },
  noteTitle: { fontSize: Font.subheadline, color: TText.primary, marginBottom: 2 },
  noteStatus: { fontSize: Font.caption, color: TText.tertiary },
});
