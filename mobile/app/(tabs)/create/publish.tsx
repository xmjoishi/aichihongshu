import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert, Linking, ActivityIndicator, Modal, Pressable, Dimensions,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { exportToAlbum } from '../../../services/media';
import { shareImagesWithText, supportsMultiImageShare } from '../../../services/share';
import { stripMarkdownForXhs, stripMarkdownForXhsTitle } from '../../../utils/xhsText';
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
  SectionLabel, Divider, PhImage, LiquidButton, GlassBackBar } from '../../../components/ui';
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
  const [sharing, setSharing] = useState(false);
  const [progress, setProgress] = useState<PublishProgress>(EMPTY_PROGRESS);
  // 预览：图片 / 笔记全文
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [notePreview, setNotePreview] = useState(false);

  if (!note) {
    return (
      <AuroraBackground style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: TText.secondary }}>草稿不存在</Text>
      </AuroraBackground>
    );
  }

  const tags: string[] = JSON.parse(note?.tags ?? '[]');
  // 话题格式：#话题 + 尾随空格（保留末尾空格，便于小红书编辑器识别话题）
  const tagsText = tags.map((t) => `#${t} `).join('');
  // 小红书标题是独立输入框：分享/粘贴进正文的内容不含标题
  // 正文去 Markdown（小红书不识别 **/#/- 等标记）
  const bodyWithTags = [stripMarkdownForXhs(note?.body ?? ''), tagsText].filter(Boolean).join('\n\n');
  const albumName = stripMarkdownForXhsTitle(note?.title || '') || '爱吃红薯导出';
  const multiShare = supportsMultiImageShare();

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
      // 进入本页不默认「已复制」：只有用户点了复制/分享才算
      setExported(saved.exported);
    })();
    return () => { cancelled = true; };
  }, [noteId]);

  async function copyText(text: string, which: 'title' | 'body') {
    if (!text) { Alert.alert('内容为空', '请先在编辑页补充内容'); return; }
    await Clipboard.setStringAsync(text);
    if (which === 'title') {
      setCopiedTitle(true);
      const next = await setPublishProgress(noteId, { copiedTitle: true });
      setProgress(next);
    }
    if (which === 'body') {
      setCopiedBody(true);
      setCopiedFull(true);
      const next = await setPublishProgress(noteId, { copiedBody: true, copiedFull: true });
      setProgress(next);
    }
  }

  async function handleExportAlbum() {
    if (linkedItems.length === 0) { Alert.alert('没有关联图片', '请先在编辑页关联图片'); return; }
    setExporting(true);
    try {
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
    // 依次尝试直达发布页/打开 App；全部失败进国区 App Store（id741292507）
    const candidates = [
      'xhsdiscover://post_note',
      'xhsdiscover://post',
      'xiaohongshu://',
      'xhsdiscover://',
      'xhsdiscovery://',
    ];
    for (const url of candidates) {
      try {
        await Linking.openURL(url);
        return;
      } catch {}
    }
    Linking.openURL('https://apps.apple.com/cn/app/id741292507');
  }

  /**
   * 主链路：系统分享面板一次带出关联图片 + 正文文案（与相册「分享」同款）。
   * 正文不含标题（小红书标题是独立输入框），话题跟在正文末尾。
   * 分享前自动把正文+话题写入剪贴板，供小红书未接收文案时粘贴兜底。
   */
  async function handleShare() {
    if (linkedItems.length === 0) {
      Alert.alert('没有关联图片', '请先在编辑页关联图片');
      return;
    }
    setSharing(true);
    try {
      if (bodyWithTags) {
        await Clipboard.setStringAsync(bodyWithTags);
        setCopiedBody(true);
        setCopiedFull(true);
        const next = await setPublishProgress(noteId, {
          copiedBody: true,
          copiedFull: true,
        });
        setProgress(next);
      }
      await shareImagesWithText(
        linkedItems.map((i) => i.imagePath),
        {
          message: bodyWithTags || undefined,
          title: note!.title || undefined,
          albumName: linkedItems.length > 1 ? albumName : undefined,
        },
      );
    } catch (e: any) {
      Alert.alert('分享失败', e?.message ?? String(e));
    } finally {
      setSharing(false);
    }
  }

  async function handleMarkDone() {
    await updateNote(noteId, { status: 'published' });
    await clearPublishProgress(noteId);
    Alert.alert('已发布 ✓', '笔记已标记为发布完成', [{ text: '好', onPress: () => router.back() }]);
  }

  // 判断步骤完成状态
  const step1Done = copiedTitle && (copiedBody || copiedFull);
  const step2Done = exported || linkedItems.length === 0;

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <GlassBackBar title="发布准备" backLabel="返回" onBack={() => router.back()} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* 关联图片横滚 */}
        {linkedItems.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.imgRow}>
                {linkedItems.map((item, i) => (
                  <Pressable key={item.id} onPress={() => setPreviewIndex(i)}>
                    <PhImage uri={item.imagePath} style={styles.thumb} />
                    <View style={styles.thumbNum}>
                      <Text style={styles.thumbNumText}>{i + 1}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
            <TouchableOpacity onPress={() => setPreviewIndex(0)} style={styles.previewLink}>
              <Ionicons name="images-outline" size={14} color={Brand.red} />
              <Text style={styles.previewLinkText}>预览图片（{linkedItems.length}）</Text>
            </TouchableOpacity>
          </View>
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
          <View style={styles.previewBodyRow}>
            <Text style={[styles.previewBody, { flex: 1 }]} numberOfLines={6}>
              {stripMarkdownForXhs(note.body ?? '') || '（无正文）'}
            </Text>
            <TouchableOpacity
              style={[styles.copyBtn, copiedBody && styles.copyBtnDone]}
              onPress={() => copyText(bodyWithTags, 'body')}
            >
              <Ionicons name={copiedBody ? 'checkmark' : 'copy-outline'} size={14} color={copiedBody ? '#fff' : TText.secondary} />
              <Text style={[styles.copyBtnText, copiedBody && styles.copyBtnTextDone]}>
                {copiedBody ? '已复制' : '复制'}
              </Text>
            </TouchableOpacity>
          </View>
          {tags.length > 0 && (
            <View style={styles.tagRow}>
              {tags.map((t) => (
                <View key={t} style={styles.tag}>
                  <Text style={styles.tagText}>#{t}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={styles.copyHint}>标题贴到小红书标题栏；正文+话题贴到正文栏</Text>
          <TouchableOpacity onPress={() => setNotePreview(true)} style={styles.previewLink}>
            <Ionicons name="document-text-outline" size={14} color={Brand.red} />
            <Text style={styles.previewLinkText}>预览笔记全文</Text>
          </TouchableOpacity>
        </LiquidCard>

        {/* 主链路：系统分享面板带图+文案 */}
        <SectionLabel style={{ marginBottom: 12 }}>一键分享</SectionLabel>
        <TouchableOpacity
          style={[styles.shareMainBtn, sharing && styles.shareMainBtnBusy]}
          onPress={handleShare}
          disabled={sharing}
        >
          {sharing
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="share-outline" size={18} color="#fff" />
          }
          <Text style={styles.shareMainBtnText}>
            {sharing
              ? '唤起分享中…'
              : linkedItems.length > 0
                ? `分享 ${linkedItems.length} 张图到小红书`
                : '分享到小红书'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.shareMainHint}>
          {multiShare
            ? '一次带出全部图片与正文（含话题），在面板中选小红书；标题是小红书独立输入框，点上方「复制」后粘贴'
            : linkedItems.length > 1
              ? `当前环境不支持一次分享多图：会把 ${linkedItems.length} 张图存入相册「${albumName}」，分享面板带文案+首图；到小红书选图时选该相册即可补齐多图`
              : '图片与正文（含话题）进分享面板，在面板中选小红书；标题是小红书独立输入框，点上方「复制」后粘贴'}
        </Text>

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
          <Step num={1} label="文案到剪贴板" done={step1Done}>
            <Text style={styles.stepHint}>点「分享」会自动复制正文+话题（不含标题）；标题请点上方「复制」，贴到小红书标题栏</Text>
          </Step>

          <View style={styles.stepDivider} />

          <Step num={2} label={linkedItems.length > 0 ? `备用：导出 ${linkedItems.length} 张图片到相册` : '无需导出图片'} done={step2Done}>
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

          <Step num={3} label="打开小红书">
            <TouchableOpacity style={[styles.stepBtn, styles.stepBtnRed]} onPress={handleOpenXHS}>
              <Ionicons name="open-outline" size={16} color="#fff" />
              <Text style={[styles.stepBtnText, { color: '#fff' }]}>打开小红书</Text>
            </TouchableOpacity>
          </Step>
        </LiquidCard>

        {/* 发布完成 */}
        <TouchableOpacity style={styles.archiveBtn} onPress={handleMarkDone}>
          <Text style={styles.archiveBtnText}>发布完成</Text>
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

      {/* 图片预览：左右滑动切换 */}
      <Modal visible={previewIndex !== null} transparent animationType="fade">
        <View style={styles.previewModal}>
          <View style={styles.previewModalBar}>
            <Text style={styles.previewModalTitle}>
              {((previewIndex ?? 0) + 1)} / {linkedItems.length}
            </Text>
            <TouchableOpacity onPress={() => setPreviewIndex(null)}>
              <Text style={styles.previewModalClose}>关闭</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: (previewIndex ?? 0) * SCREEN_W, y: 0 }}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
              if (i >= 0 && i < linkedItems.length) setPreviewIndex(i);
            }}
          >
            {linkedItems.map((item) => (
              <View key={item.id} style={{ width: SCREEN_W, flex: 1 }}>
                <PhImage uri={item.imagePath} style={styles.previewModalImg} resizeMode="contain" />
              </View>
            ))}
          </ScrollView>
          <View style={styles.previewNav}>
            <TouchableOpacity
              style={styles.previewNavBtn}
              onPress={() => setPreviewIndex((i) => (i === null || i <= 0 ? i : i - 1))}
            >
              <Text style={styles.previewNavText}>‹ 上一张</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.previewNavBtn}
              onPress={() => setPreviewIndex((i) => (i === null ? i : Math.min(i + 1, linkedItems.length - 1)))}
            >
              <Text style={styles.previewNavText}>下一张 ›</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 笔记全文预览 */}
      <Modal visible={notePreview} animationType="slide" onRequestClose={() => setNotePreview(false)}>
        <View style={[styles.previewModal, { backgroundColor: '#111' }]}>
          <View style={styles.previewModalBar}>
            <Text style={styles.previewModalTitle}>笔记预览</Text>
            <TouchableOpacity onPress={() => setNotePreview(false)}>
              <Text style={styles.previewModalClose}>关闭</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.previewModalNote}>
            <Text style={styles.previewModalNoteTitle}>{note.title || '（无标题）'}</Text>
            <Text style={styles.previewModalNoteBody}>{stripMarkdownForXhs(note.body ?? '') || '（无正文）'}</Text>
            {tags.length > 0 && (
              <Text style={[styles.previewModalNoteBody, { marginTop: 16, color: '#FF6B81' }]}>
                {tags.map((t) => `#${t}`).join(' ')}
              </Text>
            )}
          </ScrollView>
        </View>
      </Modal>
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
  previewBodyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  copyHint: { fontSize: Font.caption, color: TText.tertiary },
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
  shareMainBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: Radius.md,
    backgroundColor: Brand.red,
  },
  shareMainBtnBusy: { opacity: 0.75 },
  shareMainBtnText: { fontSize: Font.body, color: '#fff', fontWeight: Font.semibold },
  shareMainHint: {
    marginTop: 8, marginBottom: 20,
    fontSize: Font.caption, color: TText.tertiary, lineHeight: 18,
  },
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
    borderRadius: Radius.md,
    borderWidth: 2, borderColor: '#F59E0B',
    backgroundColor: '#FFFBEB',
  },
  archiveBtnText: {
    fontSize: Font.body, fontWeight: Font.semibold,
    color: '#B45309',
  },

  previewLink: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4,
  },
  previewLinkText: { fontSize: Font.footnote, color: Brand.red, fontWeight: Font.medium },

  previewModal: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  previewModalBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12,
  },
  previewModalTitle: { color: '#fff', fontSize: Font.subheadline, fontWeight: Font.semibold },
  previewModalClose: { color: '#fff', fontSize: Font.body, padding: 4 },
  previewModalImg: { flex: 1, width: '100%' },
  previewModalNote: {
    flex: 1, paddingHorizontal: 20, paddingBottom: 40,
  },
  previewModalNoteTitle: {
    color: '#fff', fontSize: Font.title3, fontWeight: Font.bold,
    marginBottom: 12, lineHeight: 30,
  },
  previewModalNoteBody: {
    color: 'rgba(255,255,255,0.88)', fontSize: Font.body, lineHeight: 26,
  },
  previewNav: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingBottom: 24 },
  previewNavBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12,
    borderRadius: Radius.md, backgroundColor: 'rgba(255,255,255,0.12)',
  },
  previewNavText: { color: '#fff', fontSize: Font.subheadline, fontWeight: Font.medium },

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
