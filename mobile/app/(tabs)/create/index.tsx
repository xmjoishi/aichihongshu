import {
  View, Text, FlatList, TouchableOpacity, Pressable,
  StyleSheet, Alert, Dimensions, ScrollView, TextInput,
  Animated, Modal,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useState, useMemo, useRef as useRefReact, useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../../../store';
import { getPublishProgress, getPublishProgressStage } from '../../../services/publishProgress';
import {
  AuroraBackground, LiquidCard, LiquidButton,
  Badge, Divider, PhImage, PageTitleBlock,
} from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys, Border } from '../../../utils/theme';
import type { Note, Item } from '../../../drizzle/schema';

const SCREEN_W = Dimensions.get('window').width;
// 双列封面流：6px 间距，16px 圆角白卡
const XHS_H_PAD = 6;
const XHS_COL_GAP = 6;
const XHS_COL_W = (SCREEN_W - XHS_H_PAD * 2 - XHS_COL_GAP) / 2;

// ─── 封面流卡片（C：大图 + 标题 + meta + 状态胶囊）────────────────
function XhsCard({
  note, coverItem, onPress, onLongPress,
}: {
  note: Note; coverItem?: Item; onPress: () => void; onLongPress: () => void;
}) {
  const isReady = note.status === 'ready';
  const isPublished = note.status === 'published' || note.status === 'archived';
  const coverH = Math.round(XHS_COL_W * 1.26);
  const itemIds: number[] = JSON.parse(note.itemIds ?? '[]');
  const statusLabel = isPublished ? '已发布' : isReady ? '待发布' : '草稿';

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.85}
      style={xc.card}
    >
      {coverItem ? (
        <PhImage uri={coverItem.imagePath} style={[xc.cover, { height: coverH }]} />
      ) : (
        <View style={[xc.coverEmpty, { height: Math.round(XHS_COL_W * 0.72) }]}>
          <MaterialCommunityIcons name="image-off-outline" size={24} color="#c9c9c9" />
        </View>
      )}

      <View style={xc.textArea}>
        <Text style={xc.title} numberOfLines={2}>
          {note.title || '暂无标题'}
        </Text>
        <View style={xc.metaRow}>
          <Text style={xc.metaText} numberOfLines={1}>
            {itemIds.length > 0 ? `${itemIds.length} 张图` : '无图'}
            {note.updatedAt ? ` · ${note.updatedAt.slice(5, 10)}` : ''}
          </Text>
          <View style={[
            xc.statusChip,
            isPublished ? xc.statusChipPublished : isReady ? xc.statusChipReady : xc.statusChipDraft,
          ]}>
            <Text style={[
              xc.statusChipText,
              isPublished ? xc.statusChipTextPublished : isReady ? xc.statusChipTextReady : xc.statusChipTextDraft,
            ]}>
              {statusLabel}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const xc = StyleSheet.create({
  card: {
    width: XHS_COL_W,
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
  },
  cover: {
    width: '100%',
    resizeMode: 'cover',
  } as any,
  coverEmpty: {
    width: '100%',
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textArea: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10, gap: 6 },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1a1a1a',
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  metaText: { fontSize: 10, color: '#A1A1AA', flex: 1 },
  statusChip: {
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 8,
  },
  statusChipDraft: { backgroundColor: '#F4F4F5' },
  statusChipReady: { backgroundColor: '#DCFCE7' },
  statusChipPublished: { backgroundColor: '#E0E7FF' },
  statusChipText: { fontSize: 10, fontWeight: '500' },
  statusChipTextDraft: { color: '#71717A' },
  statusChipTextReady: { color: '#16A34A' },
  statusChipTextPublished: { color: '#4338CA' },
});

// ─── 瀑布流容器（双列，贪心分列）────────────────────────────────
function XhsWaterfall({
  notes, itemsMap, onPress, onLongPress, onScroll, onEndReached,
}: {
  notes: Note[];
  itemsMap: Map<number, Item>;
  onPress: (n: Note) => void;
  onLongPress: (n: Note) => void;
  onScroll?: (y: number) => void;
  onEndReached?: () => void;
}) {
  const [leftCol, rightCol] = useMemo(() => {
    const left: Note[] = [];
    const right: Note[] = [];
    let lh = 0, rh = 0;
    for (const note of notes) {
      const hasCover = (JSON.parse(note.itemIds ?? '[]') as number[]).length > 0;
      // 估算卡片高度
      const imgH = hasCover
        ? Math.round(XHS_COL_W * 1.26)
        : Math.round(XHS_COL_W * 0.72);
      const titleLines = note.title && note.title.length > 14 ? 2 : 1;
      const cardH = imgH + titleLines * 18 + 6 + 24 + 16; // img + title + gap + authorRow + padding
      if (lh <= rh) { left.push(note); lh += cardH + XHS_COL_GAP; }
      else { right.push(note); rh += cardH + XHS_COL_GAP; }
    }
    return [left, right];
  }, [notes]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={xf.container}
      scrollEventThrottle={32}
      onScroll={(e) => {
        const y = e.nativeEvent.contentOffset.y;
        const h = e.nativeEvent.layoutMeasurement.height;
        const c = e.nativeEvent.contentSize.height;
        if (y + h > c - 240) onEndReached?.();
        onScroll?.(y);
      }}
    >
      {/* 小红书背景是 #f1f1f1 的浅灰 */}
      <View style={xf.cols}>
        <View style={xf.col}>
          {leftCol.map((note) => (
            <XhsCard
              key={note.id}
              note={note}
              coverItem={itemsMap.get((JSON.parse(note.itemIds ?? '[]') as number[])[0])}
              onPress={() => onPress(note)}
              onLongPress={() => onLongPress(note)}
            />
          ))}
        </View>
        <View style={xf.col}>
          {rightCol.map((note) => (
            <XhsCard
              key={note.id}
              note={note}
              coverItem={itemsMap.get((JSON.parse(note.itemIds ?? '[]') as number[])[0])}
              onPress={() => onPress(note)}
              onLongPress={() => onLongPress(note)}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const xf = StyleSheet.create({
  container: {
    paddingHorizontal: XHS_H_PAD,
    paddingTop: 8,
    paddingBottom: 110,
  },
  cols: {
    flexDirection: 'row',
    gap: XHS_COL_GAP,
    alignItems: 'flex-start',
  },
  col: { flex: 1, gap: XHS_COL_GAP },
});

type StatusFilter = 'all' | 'draft' | 'ready' | 'published' | 'withImage' | 'withoutImage';
type SortOrder = 'newest' | 'oldest' | 'created_desc' | 'created_asc';

// ─── 下拉选择器（从按钮正下方展开） ──────────────────────────────
function Dropdown<T extends string>({
  options, value, onChange,
  active, triggerRef,
  visible, onClose,
}: {
  options: { value: T; label: string }[];
  value: T; onChange: (v: T) => void;
  active: boolean;
  triggerRef: React.RefObject<View | null>;
  visible: boolean; onClose: () => void;
}) {
  const [pos, setPos] = useState({ x: 0, y: 0, w: 0 });

  useEffect(() => {
    if (visible && triggerRef.current) {
      triggerRef.current.measureInWindow((x, y, width, height) => {
        setPos({ x, y: y + height + 4, w: Math.max(width, 140) });
      });
    }
  }, [visible]);

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[dd.sheet, { top: pos.y, left: pos.x, minWidth: pos.w }]}>
        {options.map((opt, i) => {
          const isActive = opt.value === value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[dd.row, i < options.length - 1 && dd.rowBorder]}
              onPress={() => { onChange(opt.value); onClose(); }}
            >
              <Text style={[dd.rowText, isActive && dd.rowTextActive]}>{opt.label}</Text>
              {isActive && <Ionicons name="checkmark" size={15} color={Brand.red} />}
            </TouchableOpacity>
          );
        })}
      </View>
    </Modal>
  );
}

const dd = StyleSheet.create({
  sheet: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: Radius.lg,
    paddingVertical: 4,
    shadowColor: '#000', shadowOpacity: 0.13, shadowRadius: 12, shadowOffset: { width: 0, height: 3 },
    elevation: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.08)',
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 11 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#f0f0f0' },
  rowText: { fontSize: Font.subheadline, color: TText.primary, marginRight: 24 },
  rowTextActive: { color: Brand.red, fontWeight: Font.semibold as any },
});

// ─── 筛选行：左下拉排序 + 右文字 tab（等距，可横滑）──────────────
function FilterBar({
  status, onStatusChange,
  sort, onSortChange,
  counts,
}: {
  status: StatusFilter; onStatusChange: (v: StatusFilter) => void;
  sort: SortOrder; onSortChange: (v: SortOrder) => void;
  counts: Record<StatusFilter, number>;
}) {
  const [showSort, setShowSort] = useState(false);
  const sortRef = useRefReact<View>(null);

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'draft', label: '草稿' },
    { value: 'ready', label: '待发布' },
    { value: 'published', label: '已发布' },
    { value: 'withImage', label: '有图' },
    { value: 'withoutImage', label: '无图' },
  ];
  const sortOptions: { value: SortOrder; label: string }[] = [
    { value: 'newest', label: '修改最新' },
    { value: 'oldest', label: '修改最早' },
    { value: 'created_desc', label: '创建最新' },
    { value: 'created_asc', label: '创建最早' },
  ];
  const sortLabel = sortOptions.find((o) => o.value === sort)?.label ?? '修改时间';

  return (
    <View style={fb.wrap}>
      <View style={fb.leftRow}>
        {/* 左：排序下拉（固定） */}
        <TouchableOpacity
          ref={sortRef}
          style={fb.sortToggle}
          onPress={() => setShowSort((v) => !v)}
        >
          <Text style={fb.sortToggleText}>{sortLabel}</Text>
          <Ionicons name="chevron-down" size={12} color={TText.primary} />
        </TouchableOpacity>

        {/* 右：文字 tab，可横滑，不带动排序 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={fb.tabsScroll}
        >
          {statusOptions.map((o) => {
            const active = status === o.value;
            return (
              <Pressable
                key={o.value}
                onPress={() => onStatusChange(o.value)}
                style={fb.tab}
              >
                <Text style={[fb.tabText, active && fb.tabTextActive]}>
                  {o.label}{counts[o.value] > 0 ? ` ${counts[o.value]}` : ''}
                </Text>
                <View style={[fb.tabLine, active && fb.tabLineActive]} />
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <Dropdown
        options={sortOptions} value={sort} onChange={(v) => { setShowSort(false); onSortChange(v); }}
        active={false} triggerRef={sortRef}
        visible={showSort} onClose={() => setShowSort(false)}
      />
    </View>
  );
}

const fb = StyleSheet.create({
  wrap: { paddingBottom: 0 },
  leftRow: {
    flexDirection: 'row', alignItems: 'center',
    height: 42,
    paddingLeft: 0, paddingRight: 8,
  },
  sortToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    height: 42,
    paddingRight: 14,
  },
  sortToggleText: {
    fontSize: 13, color: TText.primary, fontWeight: '600', lineHeight: 18,
  },
  tabsScroll: {
    flexDirection: 'row', alignItems: 'center',
    height: 42,
    gap: 18, paddingRight: 16,
  },
  tab: {
    height: 42,
    justifyContent: 'center', alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  tabText: {
    fontSize: 13, color: TText.secondary, fontWeight: '500',
    flexShrink: 0, lineHeight: 18,
  },
  tabTextActive: { color: Brand.red, fontWeight: '600' },
  tabLine: {
    height: 2, alignSelf: 'stretch', borderRadius: 1,
    backgroundColor: 'transparent',
  },
  tabLineActive: { backgroundColor: Brand.red },
});

// ─── 主页面 ──────────────────────────────────────────────────────
export default function CreateScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const notes = useStore((s) => s.notes);
  const notesHasMore = useStore((s) => s.notesHasMore);
  const loadMoreNotes = useStore((s) => s.loadMoreNotes);
  const items = useStore((s) => s.items);
  const addNote = useStore((s) => s.addNote);
  const deleteNote = useStore((s) => s.deleteNote);

  const [searchExpanded, setSearchExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [publishProgressMap, setPublishProgressMap] = useState<Record<number, 'none' | 'copied' | 'exported'>>({});
  // 上滑收起排序/筛选行
  const [chromeVisible, setChromeVisible] = useState(true);
  const lastScrollY = useRefReact(0);

  const statusCounts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: notes.length, draft: 0, ready: 0, published: 0, withImage: 0, withoutImage: 0,
    };
    for (const n of notes) {
      const hasImg = (JSON.parse(n.itemIds ?? '[]') as number[]).length > 0;
      if (hasImg) c.withImage += 1;
      else c.withoutImage += 1;
      if (n.status === 'ready') c.ready += 1;
      else if (n.status === 'published' || n.status === 'archived') c.published += 1;
      else c.draft += 1;
    }
    return c;
  }, [notes]);

  // 搜索框展开动画（宽度 0→1）
  const searchAnim = useRefReact(new Animated.Value(0)).current;
  const inputRef = useRefReact<TextInput>(null);

  useEffect(() => {
    Animated.timing(searchAnim, {
      toValue: searchExpanded ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start(() => {
      if (searchExpanded) inputRef.current?.focus();
    });
    if (!searchExpanded) setQuery('');
  }, [searchExpanded]);

  useEffect(() => {
    let cancelled = false;
    void loadPublishProgress();
    async function loadPublishProgress() {
      const ready = notes.filter((n) => n.status === 'ready');
      if (ready.length === 0) {
        if (!cancelled) setPublishProgressMap({});
        return;
      }
      const pairs = await Promise.all(
        ready.map(async (n) => {
          const p = await getPublishProgress(n.id);
          return [n.id, getPublishProgressStage(p)] as const;
        })
      );
      if (cancelled) return;
      setPublishProgressMap(Object.fromEntries(pairs));
    }
    return () => { cancelled = true; };
  }, [notes]);

  useFocusEffect(
    useMemo(
      () => () => {
        let cancelled = false;
        (async () => {
          const ready = notes.filter((n) => n.status === 'ready');
          const pairs = await Promise.all(
            ready.map(async (n) => {
              const p = await getPublishProgress(n.id);
              return [n.id, getPublishProgressStage(p)] as const;
            })
          );
          if (!cancelled) setPublishProgressMap(Object.fromEntries(pairs));
        })();
        return () => { cancelled = true; };
      },
      [notes]
    )
  );

  const itemsMap = useMemo(() => {
    const m = new Map<number, Item>();
    for (const item of items) m.set(item.id, item);
    return m;
  }, [items]);

  // 过滤 + 排序
  const filteredNotes = useMemo(() => {
    let list = [...notes];
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (n) =>
          (n.title ?? '').toLowerCase().includes(q) ||
          (n.body ?? '').toLowerCase().includes(q),
      );
    }
    if (statusFilter === 'draft') list = list.filter((n) => n.status === 'draft');
    else if (statusFilter === 'ready') list = list.filter((n) => n.status === 'ready');
    else if (statusFilter === 'published') list = list.filter((n) => n.status === 'published' || n.status === 'archived');
    else if (statusFilter === 'withImage') list = list.filter((n) => (JSON.parse(n.itemIds ?? '[]') as number[]).length > 0);
    else if (statusFilter === 'withoutImage') list = list.filter((n) => (JSON.parse(n.itemIds ?? '[]') as number[]).length === 0);
    list.sort((a, b) => {
      if (sortOrder === 'created_desc' || sortOrder === 'created_asc') {
        const ta = new Date(a.createdAt ?? 0).getTime();
        const tb = new Date(b.createdAt ?? 0).getTime();
        return sortOrder === 'created_desc' ? tb - ta : ta - tb;
      }
      const ta = new Date(a.updatedAt ?? 0).getTime();
      const tb = new Date(b.updatedAt ?? 0).getTime();
      return sortOrder === 'newest' ? tb - ta : ta - tb;
    });
    return list;
  }, [notes, query, statusFilter, sortOrder]);

  async function handleNew() {
    // 直接进编辑页，手动上传图片
    const note = await addNote();
    router.push(`/(tabs)/create/edit/${note.id}`);
  }

  function handleLongPress(note: Note) {
    Alert.alert('删除草稿', `确认删除「${note.title || '无标题'}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => deleteNote(note.id) },
    ]);
  }

  function handlePress(note: Note) {
    router.push(`/(tabs)/create/edit/${note.id}`);
  }

  const isFiltering = query.trim() !== '' || statusFilter !== 'all';

  const otherOpacity = searchAnim.interpolate({
    inputRange: [0, 0.3],
    outputRange: [1, 0],
  });
  const searchOpacity = searchAnim.interpolate({
    inputRange: [0.2, 1],
    outputRange: [0, 1],
  });

  return (
    <AuroraBackground style={{ flex: 1, backgroundColor: 'transparent' }}>
        {/* 标题栏 — 与相册/设置同一套 PageTitleBlock */}
        <View style={{ position: 'relative' }}>
          <PageTitleBlock
            title="创作"
            count={isFiltering ? `${filteredNotes.length}/${notes.length}` : notes.length}
            right={
              <Animated.View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: otherOpacity }}
                pointerEvents={searchExpanded ? 'none' : 'auto'}
              >
                <Pressable onPress={() => setSearchExpanded(true)} style={styles.iconBtn} accessibilityLabel="搜索">
                  <Ionicons name="search" size={16} color={TText.primary} />
                </Pressable>
                <Pressable style={styles.addBtn} onPress={handleNew} accessibilityLabel="新建草稿">
                  <Ionicons name="add" size={22} color="#fff" />
                </Pressable>
              </Animated.View>
            }
          >
            {notes.length > 0 && chromeVisible && (
              <FilterBar
                status={statusFilter}
                onStatusChange={setStatusFilter}
                sort={sortOrder}
                onSortChange={setSortOrder}
                counts={statusCounts}
              />
            )}
          </PageTitleBlock>

          {/* 搜索框：叠在标题行上，展开时淡入 */}
          <Animated.View
            style={[
              styles.searchOverlay,
              { opacity: searchOpacity },
              { top: insets.top + 2, left: 18, right: 18, height: 40 },
            ]}
            pointerEvents={searchExpanded ? 'auto' : 'none'}
          >
            <Ionicons name="search" size={14} color={TText.tertiary} style={{ marginRight: 6 }} />
            <TextInput
              ref={inputRef}
              style={styles.searchInput}
              placeholder="搜索标题或正文..."
              placeholderTextColor={TText.quaternary}
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
            <Pressable onPress={() => setSearchExpanded(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          </Animated.View>
        </View>

        {notes.length === 0 ? (
          <View style={styles.empty}>
            <LiquidCard style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>还没有草稿</Text>
              <Text style={styles.emptyDesc}>从相册选图，让 AI 帮你出稿</Text>
              <LiquidButton
                label="新建草稿"
                onPress={handleNew}
                style={{ marginTop: 20, alignSelf: 'stretch' }}
              />
            </LiquidCard>
          </View>
        ) : filteredNotes.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>没有符合条件的草稿</Text>
            <Text style={[styles.emptyDesc, { marginTop: 6 }]}>
              试试修改搜索词或筛选条件
            </Text>
          </View>
        ) : (
          <XhsWaterfall
            notes={filteredNotes}
            itemsMap={itemsMap}
            onPress={handlePress}
            onLongPress={handleLongPress}
            onEndReached={() => { if (notesHasMore && statusFilter === 'all' && !query.trim()) void loadMoreNotes(); }}
            onScroll={(y) => {
              const dy = y - lastScrollY.current;
              if (dy > 8 && y > 24) {
                if (chromeVisible) setChromeVisible(false);
              } else if (dy < -8 || y < 8) {
                if (!chromeVisible) setChromeVisible(true);
              }
              lastScrollY.current = y;
            }}
          />
        )}
      </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F0F0F1' },
  pageHeader: { paddingHorizontal: 18, paddingBottom: 8, backgroundColor: 'transparent' },
  pageHeaderGray: { backgroundColor: '#F0F0F1' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 40,
    marginBottom: 0,
  },
  // 标题 + 数量（与其它 Tab 一致）
  titleGroup: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  pageTitle: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary, lineHeight: 30 },
  pageCount: {
    fontSize: Font.caption, color: TText.tertiary,
    fontWeight: '400',
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 搜索框：absolute 覆盖标题行
  searchOverlay: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Border.base,
  },
  searchInput: { flex: 1, fontSize: Font.subheadline, color: TText.primary, padding: 0 },
  cancelBtn: { paddingLeft: 8 },
  cancelText: { fontSize: Font.subheadline, color: Brand.red },
  iconBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Border.base,
  },
  addBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Brand.red,
    shadowColor: Brand.red,
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyCard: { width: '100%', gap: 6, alignItems: 'center' },
  emptyTitle: { fontSize: Font.title3, fontWeight: Font.semibold, color: TText.primary },
  emptyDesc: { fontSize: Font.subheadline, color: TText.secondary, textAlign: 'center' },
});
