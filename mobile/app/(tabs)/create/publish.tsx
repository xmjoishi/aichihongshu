import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert, Linking, ActivityIndicator,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { exportToAlbum } from '../../../services/media';
import {
  clearPublishProgress,
  EMPTY_PROGRESS,
  getPublishProgress,
  getPublishProgressStage,
  setPublishProgress,
  type PublishProgress,
} from '../../../services/publishProgress';
import {
  AuroraBackground, InlineNav, LiquidCard,
  SectionLabel, Divider, PhImage, LiquidButton,
} from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys } from '../../../utils/theme';
import Ionicons from '@expo/vector-icons/Ionicons';

// ─── 步骤行 ─────────────────────────────────────────────────────
function Step({
  num, label, done, children,
}: {
  num: number; label: string; done?: boolean; children?: React.ReactNode;
}) {
  return (
    <View style={st.wrap}>
      <View style={[st.numBadge, done && st.numBadgeDone]}>
        {done
          ? <Ionicons name="checkmark" size={14} color="#fff" />
          : <Text style={st.numText}>{num}</Text>
        }
      </View>
      <View style={st.body}>
        <Text style={[st.label, done && st.labelDone]}>{label}</Text>
        {children}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: 4 },
  numBadge: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: '#e8e8e8',
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  numBadgeDone: { backgroundColor: Sys.success },
  numText: { fontSize: 12, fontWeight: '700', color: TText.secondary },
  body: { flex: 1 },
  label: { fontSize: Font.body, color: TText.primary, fontWeight: Font.medium, marginBottom: 6 },
  labelDone: { color: TText.tertiary, textDecorationLine: 'line-through' },
});

// ─── 主页面 ─────────────────────────────────────────────────────
export default function PublishDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const noteId = Number(id);
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const updateNote = useStore((s) => s.updateNote);
  const note = notes.find((n) => n.id === noteId);
  const linkedItemIds: number[] = JSON.parse(note?.itemIds ?? '[]');
  const linkedItems = items.filter((i) => linkedItemIds.includes(i.id));

  const [copiedTitle, setCopiedTitle] = useState(false);
  const [copiedBody, setCopiedBody] = useState(false);
  const [copiedFull, setCopiedFull] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [progress, setProgress] = useState<PublishProgress>(EMPTY_PROGRESS);

  if (!note) {
    return (
      <AuroraBackground style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: TText.secondary }}>草稿不存在</Text>
      </AuroraBackground>
    );
  }

  const tags: string[] = JSON.parse(note?.tags ?? '[]');
  const tagsText = tags.map((t) => `#${t}`).join(' ');
  const fullText = [note?.title, note?.body, tagsText].filter(Boolean).join('\n\n');

  const nextReadyNote = useMemo(() => {
    const ready = notes
      .filter((n) => n.status === 'ready' && n.id !== noteId)
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
    return ready[0] ?? null;
  }, [notes, noteId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getPublishProgress(noteId);
      if (cancelled) return;
      setProgress(saved);
      setCopiedTitle(saved.copiedTitle);
      setCopiedBody(saved.copiedBody);
      setCopiedFull(saved.copiedFull);
      setExported(saved.exported);
    })();
    return () => { cancelled = true; };
  }, [noteId]);

  async function copyText(text: string, which: 'title' | 'body' | 'full') {
    if (!text) { Alert.alert('内容为空', '请先在编辑页补充内容'); return; }
    await Clipboard.setStringAsync(text);
    if (which === 'title') {
      setCopiedTitle(true);
      const next = await setPublishProgress(noteId, { copiedTitle: true });
      setProgress(next);
    }
    if (which === 'body') {
      setCopiedBody(true);
      const next = await setPublishProgress(noteId, { copiedBody: true });
      setProgress(next);
    }
    if (which === 'full') {
      setCopiedFull(true);
      const next = await setPublishProgress(noteId, { copiedFull: true });
      setProgress(next);
    }
  }

  async function handleExportAlbum() {
    if (linkedItems.length === 0) { Alert.alert('没有关联图片', '请先在编辑页关联图片'); return; }
    setExporting(true);
    try {
      const albumName = note!.title || '爱吃红薯';
      await exportToAlbum(linkedItems.map((i) => i.imagePath), albumName);
      setExported(true);
      const next = await setPublishProgress(noteId, { exported: true, exportedAt: new Date().toISOString() });
      setProgress(next);
      Alert.alert('导出成功 ✓', `${linkedItems.length} 张图片已保存到相册「${albumName}」`);
    } catch (e: any) {
      if (e.message?.includes('权限')) {
        Alert.alert('需要相册权限', '请在系统设置中开启相册写入权限', [
          { text: '去设置', onPress: () => Linking.openSettings() },
          { text: '取消', style: 'cancel' },
        ]);
      } else {
        Alert.alert('导出失败', e.message);
      }
    } finally {
      setExporting(false);
    }
  }

  async function handleOpenXHS() {
    const url = 'xhsdiscover://';
    const canOpen = await Linking.canOpenURL(url);
    Linking.openURL(canOpen ? url : 'https://apps.apple.com/cn/app/id1234567890');
  }

  async function handleMarkDone() {
    await updateNote(noteId, { status: 'draft' });
    await clearPublishProgress(noteId);
    Alert.alert('已归档 ✓', '草稿已标记为完成', [{ text: '好', onPress: () => router.back() }]);
  }

  // 判断步骤完成状态
  const step1Done = copiedTitle && (copiedBody || copiedFull);
  const step2Done = exported || linkedItems.length === 0;

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <InlineNav title="发布准备" onBack={() => router.back()} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* 关联图片横滚 */}
        {linkedItems.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            <View style={styles.imgRow}>
              {linkedItems.map((item, i) => (
                <View key={item.id}>
                  <PhImage uri={item.imagePath} style={styles.thumb} />
                  <View style={styles.thumbNum}>
                    <Text style={styles.thumbNumText}>{i + 1}</Text>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        )}

        {/* 内容预览卡 */}
        <LiquidCard style={{ gap: 10, marginBottom: 20 }}>
          <View style={styles.previewTitleRow}>
            <Text style={styles.previewTitle} numberOfLines={2}>{note.title || '（无标题）'}</Text>
            <TouchableOpacity
              style={[styles.copyBtn, copiedTitle && styles.copyBtnDone]}
              onPress={() => copyText(note.title ?? '', 'title')}
            >
              <Ionicons name={copiedTitle ? 'checkmark' : 'copy-outline'} size={14} color={copiedTitle ? '#fff' : TText.secondary} />
              <Text style={[styles.copyBtnText, copiedTitle && styles.copyBtnTextDone]}>
                {copiedTitle ? '已复制' : '复制'}
              </Text>
            </TouchableOpacity>
          </View>
          <Divider />
          <Text style={styles.previewBody} numberOfLines={6}>{note.body || '（无正文）'}</Text>
          {tags.length > 0 && (
            <View style={styles.tagRow}>
              {tags.map((t) => (
                <View key={t} style={styles.tag}>
                  <Text style={styles.tagText}>#{t}</Text>
                </View>
              ))}
            </View>
          )}
          {/* 复制按钮组 */}
          <View style={styles.copyBtnRow}>
            <TouchableOpacity
              style={[styles.copyBtnFull, copiedBody && styles.copyBtnFullDone]}
              onPress={() => copyText(note.body ?? '', 'body')}
            >
              <Ionicons name={copiedBody ? 'checkmark' : 'copy-outline'} size={14} color={copiedBody ? '#fff' : Brand.red} />
              <Text style={[styles.copyBtnFullText, copiedBody && { color: '#fff' }]}>
                {copiedBody ? '正文已复制' : '复制正文'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.copyBtnFull, styles.copyBtnFullPrimary, copiedFull && styles.copyBtnFullDone]}
              onPress={() => copyText(fullText, 'full')}
            >
              <Ionicons name={copiedFull ? 'checkmark' : 'documents-outline'} size={14} color="#fff" />
              <Text style={[styles.copyBtnFullText, { color: '#fff' }]}>
                {copiedFull ? '全文已复制' : '复制全文+标签'}
              </Text>
            </TouchableOpacity>
          </View>
        </LiquidCard>

        {/* 步骤引导 */}
        <SectionLabel style={{ marginBottom: 12 }}>发布步骤</SectionLabel>

        <LiquidCard style={{ marginBottom: 12 }}>
          <View style={styles.progressRow}>
            <Text style={styles.progressLabel}>当前进度</Text>
            <Text style={styles.progressValue}>
              {getPublishProgressStage(progress) === 'none'
                ? '未开始'
                : getPublishProgressStage(progress) === 'copied'
                  ? '已复制文案'
                  : '已导出图片'}
            </Text>
          </View>
          {progress.exportedAt ? (
            <Text style={styles.progressTime}>上次导图：{progress.exportedAt.slice(0, 16).replace('T', ' ')}</Text>
          ) : null}
        </LiquidCard>

        <LiquidCard style={{ gap: 16, marginBottom: 12 }}>
          <Step num={1} label="复制文案到剪贴板" done={step1Done}>
            <Text style={styles.stepHint}>已在上方完成标题 + 正文复制后打勾</Text>
          </Step>

          <View style={styles.stepDivider} />

          <Step num={2} label={linkedItems.length > 0 ? `导出 ${linkedItems.length} 张图片到相册` : '无需导出图片'} done={step2Done}>
            {linkedItems.length > 0 && (
              <TouchableOpacity
                style={[styles.stepBtn, exported && styles.stepBtnDone]}
                onPress={handleExportAlbum}
                disabled={exporting || exported}
              >
                {exporting
                  ? <ActivityIndicator size="small" color={Brand.red} />
                  : <Ionicons name={exported ? 'checkmark-circle' : 'download-outline'} size={16} color={exported ? Sys.success : Brand.red} />
                }
                <Text style={[styles.stepBtnText, exported && { color: Sys.success }]}>
                  {exporting ? '导出中…' : exported ? '已导出到相册' : '导出图片到相册'}
                </Text>
              </TouchableOpacity>
            )}
          </Step>

          <View style={styles.stepDivider} />

          <Step num={3} label="打开小红书，粘贴发布">
            <TouchableOpacity style={[styles.stepBtn, styles.stepBtnRed]} onPress={handleOpenXHS}>
              <Ionicons name="open-outline" size={16} color="#fff" />
              <Text style={[styles.stepBtnText, { color: '#fff' }]}>打开小红书</Text>
            </TouchableOpacity>
          </Step>
        </LiquidCard>

        {/* 归档 */}
        <TouchableOpacity style={styles.archiveBtn} onPress={handleMarkDone}>
          <Text style={styles.archiveBtnText}>发布完成，归档草稿</Text>
        </TouchableOpacity>

        {nextReadyNote && (
          <TouchableOpacity
            style={styles.nextBtn}
            onPress={() => router.replace(`/(tabs)/create/publish?id=${nextReadyNote.id}`)}
          >
            <Text style={styles.nextBtnText}>下一篇待发布：{nextReadyNote.title || '无标题'}</Text>
            <Ionicons name="arrow-forward" size={15} color={Brand.red} />
          </TouchableOpacity>
        )}
      </ScrollView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 80 },
  imgRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  thumb: { width: 90, height: 90, borderRadius: Radius.lg } as any,
  thumbNum: {
    position: 'absolute', bottom: 4, right: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  thumbNumText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  previewTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  previewTitle: { flex: 1, fontSize: Font.title3, fontWeight: Font.bold, color: TText.primary },
  copyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: Radius.pill,
    backgroundColor: '#f0f0f0',
  },
  copyBtnDone: { backgroundColor: Sys.success },
  copyBtnText: { fontSize: Font.caption, color: TText.secondary },
  copyBtnTextDone: { color: '#fff' },

  previewBody: { fontSize: Font.body, color: TText.secondary, lineHeight: 24 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  tag: {
    backgroundColor: Brand.redSoft, borderRadius: Radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 0.5, borderColor: Brand.redMid,
  },
  tagText: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.medium },

  copyBtnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  copyBtnFull: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 9, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Brand.red,
  },
  copyBtnFullPrimary: { backgroundColor: Brand.red },
  copyBtnFullDone: { backgroundColor: Sys.success, borderColor: Sys.success },
  copyBtnFullText: { fontSize: Font.footnote, color: Brand.red, fontWeight: Font.medium },

  stepDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Glass.borderSubtle },
  stepHint: { fontSize: Font.caption, color: TText.tertiary, lineHeight: 18 },
  stepBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 7, paddingHorizontal: 12,
    borderRadius: Radius.pill,
    borderWidth: 1, borderColor: Brand.red,
  },
  stepBtnDone: { borderColor: Sys.success },
  stepBtnRed: { backgroundColor: Brand.red, borderColor: Brand.red },
  stepBtnText: { fontSize: Font.footnote, color: Brand.red, fontWeight: Font.medium },

  archiveBtn: {
    alignItems: 'center', paddingVertical: 14,
    borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
  },
  archiveBtnText: { fontSize: Font.body, color: TText.tertiary },

  progressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  progressLabel: { fontSize: Font.footnote, color: TText.tertiary },
  progressValue: { fontSize: Font.subheadline, color: Brand.red, fontWeight: Font.semibold },
  progressTime: { marginTop: 6, fontSize: Font.caption, color: TText.tertiary },

  nextBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Brand.redMid,
    backgroundColor: Brand.redSoft,
  },
  nextBtnText: { flex: 1, marginRight: 8, fontSize: Font.footnote, color: Brand.red, fontWeight: Font.medium },
});
