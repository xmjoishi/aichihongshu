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
  Badge, Divider, PhImage,
} from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys } from '../../../utils/theme';
import type { Note, Item } from '../../../drizzle/schema';

type ViewMode = 'list' | 'waterfall';

const SCREEN_W = Dimensions.get('window').width;
// 小红书双列间距 6px，左右 padding 各 6px
const XHS_H_PAD = 6;
const XHS_COL_GAP = 6;
const XHS_COL_W = (SCREEN_W - XHS_H_PAD * 2 - XHS_COL_GAP) / 2;

// 列表视图
const LIST_H_PAD = 14;
const LIST_GAP = 10;

// ─── 视图切换按钮 ────────────────────────────────────────────────
function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <View style={tog.wrap}>
      {([
        { m: 'list' as ViewMode, icon: 'list-outline' },
        { m: 'waterfall' as ViewMode, icon: 'grid-outline' },
      ]).map(({ m, icon }) => (
        <Pressable
          key={m}
          onPress={() => onChange(m)}
          style={[tog.btn, mode === m && tog.btnActive]}
        >
          <Ionicons
            name={icon as any}
            size={16}
            style={[tog.icon, mode === m && tog.iconActive]}
          />
        </Pressable>
      ))}
    </View>
  );
}

const tog = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  btn: { paddingHorizontal: 10, paddingVertical: 6 },
  btnActive: { backgroundColor: Brand.red },
  icon: { fontSize: 15, color: TText.secondary },
  iconActive: { color: '#fff' },
});

// ─── 列表卡片（带封面横幅）───────────────────────────────────────
function ListCard({
  note, onPress, onLongPress, onPublish, publishStage,
}: {
  note: Note; onPress: () => void; onLongPress: () => void; onPublish: () => void; publishStage?: 'none' | 'copied' | 'exported';
}) {
  const isReady = note.status === 'ready';
  const itemIds: number[] = JSON.parse(note.itemIds ?? '[]');
  return (
    <LiquidCard onPress={onPress} onLongPress={onLongPress} style={lc.card}>
      <View style={lc.top}>
        <Text style={lc.title} numberOfLines={1}>{note.title || '无标题'}</Text>
        <Badge label={isReady ? '待发布' : '草稿'} color={isReady ? Sys.success : Sys.warning} />
      </View>
      <Text style={lc.excerpt} numberOfLines={2}>
        {note.body || '暂无内容，点击继续编辑…'}
      </Text>
      <Divider />
      <View style={lc.meta}>
        <Text style={lc.metaText}>{itemIds.length > 0 ? `${itemIds.length} 张图` : '无图片'}</Text>
        <View style={lc.metaRight}>
          <Text style={lc.metaText}>{note.updatedAt?.slice(0, 10)}</Text>
          {isReady && (
            <TouchableOpacity style={lc.publishBtn} onPress={onPublish}>
              <Text style={lc.publishBtnText}>
                {publishStage === 'exported' ? '继续发布' : publishStage === 'copied' ? '继续导图' : '去发布'}
              </Text>
              <Ionicons name="arrow-forward" size={11} color={Brand.red} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </LiquidCard>
  );
}

const lc = StyleSheet.create({
  card: { gap: 0, padding: 0, overflow: 'hidden' },
  cover: { width: '100%', height: 160 } as any,
  body: { padding: 14, gap: 8 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: Font.headline, fontWeight: Font.semibold, color: TText.primary, flex: 1, marginRight: 8 },
  excerpt: { fontSize: Font.subheadline, color: TText.secondary, lineHeight: 20 },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metaText: { fontSize: Font.caption, color: TText.tertiary },
  metaRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  publishBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill, backgroundColor: Brand.redSoft, borderWidth: 0.5, borderColor: Brand.redMid },
  publishBtnText: { fontSize: Font.caption, color: Brand.red, fontWeight: Font.semibold as any },
});

// ─── 小红书风格瀑布流卡片 ─────────────────────────────────────────
//
// 结构（严格还原）：
//   ┌─────────────────┐
//   │   封面图（可变高）  │  ← 圆角只在顶部
//   ├─────────────────┤
//   │ 标题（2行）       │  ← 13px 黑色半粗
//   │ ──────────────  │
//   │ 头像 昵称 点赞数据 │  ← 12px 灰色
//   └─────────────────┘
//
function XhsCard({
  note, coverItem, onPress, onLongPress,
}: {
  note: Note; coverItem?: Item; onPress: () => void; onLongPress: () => void;
}) {
  const isReady = note.status === 'ready';
  // 封面图高度：模拟小红书约 3:4 比例（宽 COL_W，高 * 1.26）
  const coverH = Math.round(XHS_COL_W * 1.26);

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.85}
      style={xc.card}
    >
      {/* ① 封面图 */}
      {coverItem ? (
        <PhImage uri={coverItem.imagePath} style={[xc.cover, { height: coverH }]} />
      ) : (
        // 无封面：纯色占位，高度稍矮（内容卡）
        <View style={[xc.coverEmpty, { height: Math.round(XHS_COL_W * 0.72) }]}> 
          <MaterialCommunityIcons name="image-off-outline" size={24} color="#c9c9c9" />
        </View>
      )}

      {/* 状态角标（悬浮在封面右上角） */}
      <View style={[xc.statusDot, isReady ? xc.statusDotReady : xc.statusDotDraft]} />

      {/* ② 标题 */}
      <View style={xc.textArea}>
        <Text style={xc.title} numberOfLines={2}>
          {note.title || '暂无标题'}
        </Text>

        {/* ③ 底部作者行（用草稿状态 + 日期模拟） */}
        <View style={xc.authorRow}>
          {/* 头像占位圆 */}
          <View style={xc.avatar}>
            <Text style={xc.avatarText}>我</Text>
          </View>
          <Text style={xc.authorName} numberOfLines={1}>草稿</Text>
          {/* 点赞数（用字数模拟互动） */}
          <View style={xc.likeRow}>
            <Ionicons name="heart-outline" size={11} style={xc.likeIcon} />
            <Text style={xc.likeCount}>
              {isReady ? '待发' : note.updatedAt?.slice(5, 10) ?? '--'}
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
    borderRadius: 10,
    overflow: 'hidden',
    // 小红书卡片无显式阴影，靠白底与灰页面背景区分
  },
  // 封面图
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
  // 状态角标（右上角小圆点）
  statusDot: {
    position: 'absolute', top: 8, right: 8,
    width: 8, height: 8, borderRadius: 4,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  statusDotReady: { backgroundColor: Sys.success },
  statusDotDraft: { backgroundColor: '#f5a623' },

  // 文字区
  textArea: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8, gap: 6 },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1a1a1a',
    lineHeight: 18,
  },

  // 底部作者行
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  avatar: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: Brand.red,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 8, color: '#fff', fontWeight: '700' },
  authorName: { fontSize: 11, color: '#999', flex: 1 },
  likeRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  likeIcon: { fontSize: 11, color: '#999' },
  likeCount: { fontSize: 11, color: '#999' },
});

// ─── 瀑布流容器（双列，贪心分列）────────────────────────────────
function XhsWaterfall({
  notes, itemsMap, onPress, onLongPress,
}: {
  notes: Note[];
  itemsMap: Map<number, Item>;
  onPress: (n: Note) => void;
  onLongPress: (n: Note) => void;
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
    paddingTop: 6,
    paddingBottom: 110,
  },
  cols: {
    flexDirection: 'row',
    gap: XHS_COL_GAP,
    alignItems: 'flex-start',
  },
  col: { flex: 1, gap: XHS_COL_GAP },
});

type StatusFilter = 'all' | 'draft' | 'ready';
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

// ─── 筛选行：两个胶囊按钮 ─────────────────────────────────────────
function FilterBar({
  status, onStatusChange,
  sort, onSortChange,
}: {
  status: StatusFilter; onStatusChange: (v: StatusFilter) => void;
  sort: SortOrder; onSortChange: (v: SortOrder) => void;
}) {
  const [showFilter, setShowFilter] = useState(false);
  const [showSort, setShowSort] = useState(false);
  const filterRef = useRefReact<View>(null);
  const sortRef = useRefReact<View>(null);

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'draft', label: '草稿' },
    { value: 'ready', label: '待发布' },
  ];
  const sortOptions: { value: SortOrder; label: string }[] = [
    { value: 'newest', label: '修改最新' },
    { value: 'oldest', label: '修改最早' },
    { value: 'created_desc', label: '创建最新' },
    { value: 'created_asc', label: '创建最早' },
  ];
  const statusLabel = statusOptions.find((o) => o.value === status)?.label ?? '筛选';
  const sortLabel = sortOptions.find((o) => o.value === sort)?.label ?? '排序';
  const filterActive = status !== 'all';

  return (
    <View style={fb.row}>
      <TouchableOpacity
        ref={filterRef}
        style={[fb.pill, filterActive && fb.pillActive]}
        onPress={() => { setShowSort(false); setShowFilter((v) => !v); }}
      >
        <Ionicons name="options-outline" size={13} color={filterActive ? Brand.red : TText.secondary} />
        <Text style={[fb.pillText, filterActive && fb.pillTextActive]}>{statusLabel}</Text>
        <Ionicons name={showFilter ? 'chevron-up' : 'chevron-down'} size={11} color={filterActive ? Brand.red : TText.secondary} />
      </TouchableOpacity>

      <TouchableOpacity
        ref={sortRef}
        style={fb.pill}
        onPress={() => { setShowFilter(false); setShowSort((v) => !v); }}
      >
        <Ionicons name="swap-vertical-outline" size={13} color={TText.secondary} />
        <Text style={fb.pillText}>{sortLabel}</Text>
        <Ionicons name={showSort ? 'chevron-up' : 'chevron-down'} size={11} color={TText.secondary} />
      </TouchableOpacity>

      <Dropdown
        options={statusOptions} value={status} onChange={onStatusChange}
        active={filterActive} triggerRef={filterRef}
        visible={showFilter} onClose={() => setShowFilter(false)}
      />
      <Dropdown
        options={sortOptions} value={sort} onChange={onSortChange}
        active={false} triggerRef={sortRef}
        visible={showSort} onClose={() => setShowSort(false)}
      />
    </View>
  );
}

const fb = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 8 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 0.5, borderColor: Glass.border,
    backgroundColor: Glass.bg,
  },
  pillActive: { borderColor: Brand.redMid, backgroundColor: Brand.redSoft },
  pillText: { fontSize: Font.footnote, color: TText.secondary },
  pillTextActive: { color: Brand.red, fontWeight: Font.semibold as any },
});

// ─── 主页面 ──────────────────────────────────────────────────────
export default function CreateScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const notes = useStore((s) => s.notes);
  const items = useStore((s) => s.items);
  const addNote = useStore((s) => s.addNote);
  const deleteNote = useStore((s) => s.deleteNote);

  const [viewMode, setViewMode] = useState<ViewMode>('waterfall');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [publishProgressMap, setPublishProgressMap] = useState<Record<number, 'none' | 'copied' | 'exported'>>({});

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
    if (statusFilter === 'draft') list = list.filter((n) => n.status !== 'ready');
    else if (statusFilter === 'ready') list = list.filter((n) => n.status === 'ready');
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
    const note = await addNote();
    router.push(`/(tabs)/create/chat?noteId=${note.id}`);
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

  function renderListItem({ item }: { item: Note }) {
    return (
      <ListCard
        note={item}
        onPress={() => handlePress(item)}
        onLongPress={() => handleLongPress(item)}
        onPublish={() => router.push(`/(tabs)/create/publish?id=${item.id}`)}
        publishStage={publishProgressMap[item.id]}
      />
    );
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
    <View style={[styles.root, viewMode === 'waterfall' && styles.rootGray]}>
      <AuroraBackground style={{ flex: 1, backgroundColor: 'transparent' }}>
        {/* 标题栏 */}
        <View style={[
          styles.pageHeader,
          { paddingTop: insets.top + 8 },
          viewMode === 'waterfall' && styles.pageHeaderGray,
        ]}>
          {/* 标题行：固定高度，搜索框 absolute 叠在上面，不影响布局 */}
          <View style={styles.headerRow}>
            {/* 左：标题 + 数量（同行） */}
            <Animated.View style={[styles.titleGroup, { opacity: otherOpacity }]} pointerEvents={searchExpanded ? 'none' : 'auto'}>
              <Text style={styles.pageTitle}>创作</Text>
              {notes.length > 0 && (
                <Text style={styles.pageCount}>
                  {isFiltering ? `${filteredNotes.length}/${notes.length}` : notes.length}
                </Text>
              )}
            </Animated.View>

            {/* 右：按钮组 */}
            <Animated.View style={[styles.headerRight, { opacity: otherOpacity }]} pointerEvents={searchExpanded ? 'none' : 'auto'}>
              <Pressable onPress={() => setSearchExpanded(true)} style={styles.iconBtn}>
                <Ionicons name="search" size={16} color={TText.primary} />
              </Pressable>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              <Pressable style={styles.addBtn} onPress={handleNew}>
                <Ionicons name="add" size={22} color="#fff" />
              </Pressable>
            </Animated.View>

            {/* 搜索框：absolute 覆盖整行，展开时淡入 */}
            <Animated.View
              style={[styles.searchOverlay, { opacity: searchOpacity }]}
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

          {/* 筛选/排序 */}
          {notes.length > 0 && (
            <FilterBar
              status={statusFilter}
              onStatusChange={setStatusFilter}
              sort={sortOrder}
              onSortChange={setSortOrder}
            />
          )}
        </View>

        {notes.length === 0 ? (
          <View style={styles.empty}>
            <LiquidCard style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>还没有草稿</Text>
              <Text style={styles.emptyDesc}>从图库选图，让 AI 帮你出稿</Text>
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
        ) : viewMode === 'list' ? (
          <FlatList
            data={filteredNotes}
            keyExtractor={(n) => String(n.id)}
            renderItem={renderListItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          />
        ) : (
          <XhsWaterfall
            notes={filteredNotes}
            itemsMap={itemsMap}
            onPress={handlePress}
            onLongPress={handleLongPress}
          />
        )}
      </AuroraBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fafafa' },
  rootGray: { backgroundColor: '#f1f1f1' },
  pageHeader: { paddingHorizontal: 14, paddingBottom: 2, backgroundColor: 'transparent' },
  pageHeaderGray: { backgroundColor: '#f1f1f1' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
    marginBottom: 4,
  },
  // 标题 + 数量同行
  titleGroup: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  pageTitle: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary },
  pageCount: {
    fontSize: Font.footnote, color: TText.tertiary,
    fontWeight: '400',
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 搜索框：absolute 覆盖整行
  searchOverlay: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  searchInput: { flex: 1, fontSize: Font.subheadline, color: TText.primary, padding: 0 },
  cancelBtn: { paddingLeft: 8 },
  cancelText: { fontSize: Font.subheadline, color: Brand.red },
  iconBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
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
  listContent: { padding: LIST_H_PAD, gap: LIST_GAP, paddingBottom: 110 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyCard: { width: '100%', gap: 6, alignItems: 'center' },
  emptyTitle: { fontSize: Font.title3, fontWeight: Font.semibold, color: TText.primary },
  emptyDesc: { fontSize: Font.subheadline, color: TText.secondary, textAlign: 'center' },
});
