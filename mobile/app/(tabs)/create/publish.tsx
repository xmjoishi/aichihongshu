import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert, Linking, ActivityIndicator, Modal, Pressable, Dimensions,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../../../store';
import { exportToAlbum } from '../../../services/media';
import { shareImagesWithText, supportsMultiImageShare } from '../../../services/share';
import { stripMarkdownForXhsTitle } from '../../../utils/xhsText';
import { buildPublishText } from '../../../utils/publishText';
import {
  clearPublishProgress,
  EMPTY_PROGRESS,
  getPublishProgress,
  setPublishProgress,
  type PublishProgress,
} from '../../../services/publishProgress';
import { AuroraBackground, LiquidCard, Divider, PhImage, GlassBackBar } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys } from '../../../utils/theme';
import Ionicons from '@expo/vector-icons/Ionicons';

// ─── 主页面 ─────────────────────────────────────────────────────
export default function PublishDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const noteId = Number(id);
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const updateNote = useStore((s) => s.updateNote);
  const note = notes.find((n) => n.id === noteId);
  const linkedItemIds: number[] = JSON.parse(note?.itemIds ?? '[]');
  const itemById = new Map(items.map((item) => [item.id, item]));
  const linkedItems = linkedItemIds.flatMap((itemId) => {
    const item = itemById.get(itemId);
    return item ? [item] : [];
  });

  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [progress, setProgress] = useState<PublishProgress>(EMPTY_PROGRESS);
  // 预览：图片 / 笔记全文
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [notePreview, setNotePreview] = useState(false);
  const [copyOptionsOpen, setCopyOptionsOpen] = useState(false);
  const [otherActionsOpen, setOtherActionsOpen] = useState(false);
  const progressNoteId = useRef<number | null>(null);

  const nextReadyNote = useMemo(() => {
    const ready = notes
      .filter((n) => n.status === 'ready' && n.id !== noteId)
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
    return ready[0] ?? null;
  }, [notes, noteId]);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    const isNewNote = progressNoteId.current !== noteId;
    progressNoteId.current = noteId;
    if (isNewNote) {
      setProgress(EMPTY_PROGRESS);
      (async () => {
        const saved = await getPublishProgress(noteId);
        if (!cancelled) setProgress(saved);
      })();
    } else {
      // Returning from edit may mean the copied text is stale; clear only the copy/share result, keeping album export history.
      setProgress((current) => ({
        ...current,
        copiedTitle: false,
        copiedBody: false,
        copiedFull: false,
        lastShareResult: undefined,
        shareAttemptAt: undefined,
      }));
      void setPublishProgress(noteId, {
        copiedTitle: false,
        copiedBody: false,
        copiedFull: false,
        lastShareResult: undefined,
        shareAttemptAt: undefined,
      }).then((saved) => { if (!cancelled) setProgress(saved); });
    }
    return () => { cancelled = true; };
  }, [noteId]));

  if (!note) {
    return (
      <AuroraBackground style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: TText.secondary }}>草稿不存在</Text>
      </AuroraBackground>
    );
  }

  const tags: string[] = JSON.parse(note?.tags ?? '[]');
  const { title: shareTitle, bodyWithTags, fullText } = buildPublishText(note.title ?? '', note.body ?? '', tags);
  const albumName = stripMarkdownForXhsTitle(note?.title || '') || '爱吃红薯导出';
  const multiShare = supportsMultiImageShare();

  async function copyText(text: string, which: 'title' | 'body' | 'full') {
    if (!text) { Alert.alert('内容为空', '请先在编辑页补充内容'); return; }
    await Clipboard.setStringAsync(text);
    if (which === 'title') {
      const next = await setPublishProgress(noteId, { copiedTitle: true });
      setProgress(next);
    }
    if (which === 'body') {
      const next = await setPublishProgress(noteId, { copiedBody: true });
      setProgress(next);
    }
    if (which === 'full') {
      setProgress(await setPublishProgress(noteId, { copiedFull: true }));
    }
  }

  async function handleExportAlbum() {
    if (linkedItems.length === 0) { Alert.alert('没有关联图片', '请先在编辑页关联图片'); return; }
    setExporting(true);
    try {
      await exportToAlbum(linkedItems.map((i) => i.imagePath), albumName);
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
   * 主链路：关联图片 + 标题、正文、话题；分享前复制完整文案兜底。
   * title 仅是系统元信息，接收端可能忽略，因此 message 内也包含标题。
   */
  async function handleShare() {
    if (linkedItems.length === 0) {
      Alert.alert('没有关联图片', '请先在编辑页关联图片');
      return;
    }
    setSharing(true);
    const attemptedAt = new Date().toISOString();
    try {
      setProgress(await setPublishProgress(noteId, {
        shareAttemptAt: attemptedAt,
        lastShareResult: 'preparing',
      }));
      if (fullText) {
        await Clipboard.setStringAsync(fullText);
        const next = await setPublishProgress(noteId, {
          copiedFull: true,
        });
        setProgress(next);
      }
      // fallback 分享面板只接收首图；先明确保存整组图片，保存失败时不要继续给出误导性分享。
      if (!multiShare && linkedItems.length > 1) {
        await exportToAlbum(linkedItems.map((i) => i.imagePath), albumName);
        const next = await setPublishProgress(noteId, {
          exported: true,
          exportedAt: attemptedAt,
        });
        setProgress(next);
      }
      const outcome = await shareImagesWithText(
        linkedItems.map((i) => i.imagePath),
        {
          message: fullText || undefined,
          title: shareTitle || undefined,
          albumName: linkedItems.length > 1 ? albumName : undefined,
          skipFallbackExport: true,
        },
      );
      setProgress(await setPublishProgress(noteId, {
        shareAttemptAt: attemptedAt,
        lastShareResult: outcome,
      }));
    } catch (e: any) {
      setProgress(await setPublishProgress(noteId, {
        shareAttemptAt: attemptedAt,
        lastShareResult: 'failed',
      }));
      Alert.alert('分享未完成', `${e?.message ?? String(e)}\n\n可在“其他操作”中先导出图片，再单独打开小红书。`);
    } finally {
      setSharing(false);
    }
  }

  async function handleMarkDone() {
    try {
      // This explicit user action is the only path that records publication.
      await updateNote(noteId, { status: 'published' });
      await clearPublishProgress(noteId);
      Alert.alert('发布结果已记录', '这篇笔记已标记为已发布。', [{ text: '好', onPress: () => router.back() }]);
    } catch (e: any) {
      Alert.alert('记录失败', e?.message ?? '请重试');
    }
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <GlassBackBar
        title="发布准备"
        backLabel="返回"
        onBack={() => router.back()}
        right={(
          <TouchableOpacity onPress={() => router.push(`/(tabs)/create/edit/${noteId}`)} style={styles.editLink}>
            <Ionicons name="create-outline" size={15} color={Brand.red} />
            <Text style={styles.editLinkText}>返回编辑</Text>
          </TouchableOpacity>
        )}
      />

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* 内容预览卡 */}
        <LiquidCard style={{ gap: 10, marginBottom: 20 }}>
          <Text style={styles.previewTitle} numberOfLines={2}>{shareTitle || '（无标题）'}</Text>
          <Divider />
          <Text style={styles.previewBody} numberOfLines={4}>
            {bodyWithTags || '（无正文）'}
          </Text>
          <View style={styles.contentActionRow}>
            <TouchableOpacity onPress={() => setNotePreview(true)} style={styles.previewLink}>
              <Ionicons name="document-text-outline" size={14} color={Brand.red} />
              <Text style={styles.previewLinkText}>查看完整文案</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.copyBtnFull, progress.copiedFull && styles.copyBtnFullDone]} onPress={() => copyText(fullText, 'full')}>
              <Ionicons name={progress.copiedFull ? 'checkmark' : 'copy-outline'} size={15} color={progress.copiedFull ? '#fff' : Brand.red} />
              <Text style={[styles.copyBtnFullText, progress.copiedFull && styles.copyBtnFullTextDone]}>{progress.copiedFull ? '已复制完整文案' : '复制完整文案'}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => setCopyOptionsOpen((open) => !open)} style={styles.secondaryToggle}>
            <Text style={styles.secondaryToggleText}>{copyOptionsOpen ? '收起分项复制' : '分别复制标题或正文'}</Text>
            <Ionicons name={copyOptionsOpen ? 'chevron-up' : 'chevron-down'} size={14} color={TText.tertiary} />
          </TouchableOpacity>
          {copyOptionsOpen && (
            <View style={styles.copyOptions}>
              <TouchableOpacity style={styles.copyOption} onPress={() => copyText(shareTitle, 'title')}>
                <Text style={styles.copyOptionText}>{progress.copiedTitle ? '标题已复制' : '复制标题'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.copyOption} onPress={() => copyText(bodyWithTags, 'body')}>
                <Text style={styles.copyOptionText}>{progress.copiedBody ? '正文已复制' : '复制正文和话题'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </LiquidCard>

        {/* 先预览标题和正文，再按 note.itemIds 保存顺序核对图片/封面 */}
        {linkedItems.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <View style={styles.imageHeader}>
              <Text style={styles.imageHeaderText}>发布图片顺序</Text>
              <Text style={styles.imageCount}>共 {linkedItems.length} 张</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.imgRow}>
                {linkedItems.map((item, i) => (
                  <Pressable key={item.id} onPress={() => setPreviewIndex(i)}>
                    <PhImage uri={item.imagePath} style={styles.thumb} />
                    {i === 0 && (
                      <View style={styles.coverBadge}>
                        <Text style={styles.coverBadgeText}>封面</Text>
                      </View>
                    )}
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

        <TouchableOpacity onPress={() => setOtherActionsOpen((open) => !open)} style={styles.moreActionsToggle}>
          <Text style={styles.moreActionsTitle}>其他操作</Text>
          <Ionicons name={otherActionsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={TText.tertiary} />
        </TouchableOpacity>
        {otherActionsOpen && (
          <LiquidCard style={styles.otherActions}>
            <TouchableOpacity style={styles.otherAction} onPress={handleExportAlbum} disabled={exporting || progress.exported}>
              {exporting ? <ActivityIndicator size="small" color={Brand.red} /> : <Ionicons name={progress.exported ? 'checkmark-circle' : 'download-outline'} size={17} color={progress.exported ? Sys.success : Brand.red} />}
              <Text style={[styles.otherActionText, progress.exported && { color: Sys.success }]}>{progress.exported ? '图片已保存到相册' : '单独导出图片到相册'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.otherAction} onPress={handleOpenXHS}>
              <Ionicons name="open-outline" size={17} color={Brand.red} />
              <Text style={styles.otherActionText}>单独打开小红书</Text>
            </TouchableOpacity>
            {progress.exportedAt && <Text style={styles.progressTime}>上次保存：{progress.exportedAt.slice(0, 16).replace('T', ' ')}</Text>}
          </LiquidCard>
        )}

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

      <View style={[styles.bottomDock, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {linkedItems.length === 0 ? (
          <Text style={styles.shareMainHint}>这篇笔记还没有关联图片，请返回编辑添加图片后再分享。</Text>
        ) : !multiShare && linkedItems.length > 1 ? (
          <Text style={styles.shareMainHint}>
            将先保存全部 {linkedItems.length} 张图片；分享面板只带封面和文案。进入小红书后，请从系统相册补选其余 {linkedItems.length - 1} 张。
          </Text>
        ) : (
          <Text style={styles.shareMainHint}>
            {multiShare && linkedItems.length > 1
              ? `分享面板会带出全部 ${linkedItems.length} 张图片和文案；选择小红书后继续完成编辑与发布。`
              : '分享面板会带出图片和完整文案；选择小红书后继续完成编辑与发布。'}
          </Text>
        )}
        {progress.lastShareResult && (
          <View style={styles.shareResult}>
            <Text style={styles.shareResultText}>
              {progress.lastShareResult === 'shared'
                ? '已从系统分享面板返回；这不代表小红书已发布。发布成功后，可点击下方按钮记录。'
                : progress.lastShareResult === 'dismissed'
                  ? '已取消分享，文案仍在剪贴板，笔记保持待发布。'
                  : progress.lastShareResult === 'preparing'
                    ? '正在准备系统分享面板；笔记仍处于待发布。'
                    : '分享未完成，笔记仍处于待发布。'}
            </Text>
          </View>
        )}
        <TouchableOpacity onPress={handleMarkDone} style={styles.publishConfirmLink}>
          <Text style={styles.publishConfirmText}>我已在小红书完成发布</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.shareMainBtn, sharing && styles.shareMainBtnBusy]}
          onPress={handleShare}
          disabled={sharing || linkedItems.length === 0}
        >
          {sharing ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="share-outline" size={18} color="#fff" />}
          <Text style={styles.shareMainBtnText}>
            {sharing
              ? '准备分享…'
              : linkedItems.length === 0
                ? '请先关联图片'
              : multiShare
                ? `分享 ${linkedItems.length} 张图和文案`
                : linkedItems.length > 1
                  ? `保存 ${linkedItems.length} 张，分享封面和文案`
                  : '分享图片和文案'}
          </Text>
        </TouchableOpacity>
      </View>

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
            <Text style={styles.previewModalNoteTitle}>{shareTitle || '（无标题）'}</Text>
            <Text style={styles.previewModalNoteBody}>{bodyWithTags || '（无正文）'}</Text>
          </ScrollView>
        </View>
      </Modal>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 24 },
  editLink: { flexDirection: 'row', gap: 3, alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8 },
  editLinkText: { fontSize: Font.footnote, color: Brand.red, fontWeight: Font.medium },
  imageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 4 },
  imageHeaderText: { fontSize: Font.footnote, color: TText.secondary, fontWeight: Font.medium },
  imageCount: { fontSize: Font.caption, color: TText.tertiary },
  imgRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  thumb: { width: 90, height: 90, borderRadius: Radius.lg } as any,
  thumbNum: {
    position: 'absolute', bottom: 4, right: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  thumbNumText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  coverBadge: { position: 'absolute', left: 4, bottom: 4, backgroundColor: Brand.red, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  coverBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  previewTitle: { flex: 1, fontSize: Font.title3, fontWeight: Font.bold, color: TText.primary },
  previewBody: { fontSize: Font.body, color: TText.secondary, lineHeight: 24 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  tag: {
    backgroundColor: Brand.redSoft, borderRadius: Radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 0.5, borderColor: Brand.redMid,
  },
  tagText: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.medium },

  copyBtnFull: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 9, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Brand.red,
  },
  copyBtnFullDone: { backgroundColor: Sys.success, borderColor: Sys.success },
  copyBtnFullText: { fontSize: Font.footnote, color: Brand.red, fontWeight: Font.medium },
  copyBtnFullTextDone: { color: '#fff' },
  contentActionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  tagCount: { fontSize: Font.caption, color: TText.tertiary, alignSelf: 'center' },
  secondaryToggle: { flexDirection: 'row', gap: 4, alignItems: 'center', alignSelf: 'flex-start', paddingTop: 2 },
  secondaryToggleText: { fontSize: Font.caption, color: TText.tertiary },
  copyOptions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  copyOption: { borderRadius: Radius.pill, backgroundColor: '#f5f5f5', paddingHorizontal: 12, paddingVertical: 7 },
  copyOptionText: { fontSize: Font.caption, color: TText.secondary },

  shareMainBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: Radius.md,
    backgroundColor: Brand.red,
  },
  shareMainBtnBusy: { opacity: 0.75 },
  shareMainBtnText: { fontSize: Font.body, color: '#fff', fontWeight: Font.semibold },
  shareMainHint: { fontSize: Font.caption, color: TText.tertiary, lineHeight: 18 },
  moreActionsToggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
  moreActionsTitle: { fontSize: Font.footnote, color: TText.secondary, fontWeight: Font.medium },
  otherActions: { gap: 12, marginBottom: 14 },
  otherAction: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  otherActionText: { fontSize: Font.footnote, color: Brand.red },
  bottomDock: { gap: 10, paddingHorizontal: 16, paddingTop: 12, backgroundColor: 'rgba(255,255,255,0.94)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Glass.borderSubtle },
  shareResult: { gap: 6, padding: 10, borderRadius: Radius.md, backgroundColor: Brand.redSoft },
  shareResultText: { fontSize: Font.caption, color: TText.secondary, lineHeight: 17 },
  publishConfirmLink: { alignSelf: 'flex-start', paddingVertical: 2 },
  publishConfirmText: { fontSize: Font.footnote, color: Brand.red, fontWeight: Font.semibold },

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
