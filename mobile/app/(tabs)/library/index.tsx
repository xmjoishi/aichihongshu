import {
  View,
  Text,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Alert,
  Dimensions,
  StatusBar,
  Pressable,
  Animated,
  ActivityIndicator,
  Platform,
  type ViewToken,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useRef, useCallback, useEffect, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { useStore } from '../../../store';
import {
  fetchAssets,
  requestMediaPermission,
  presentPermissionPicker,
  openAppSettings,
  readBase64FromAsset,
  resolveLocalUri,
  subscribeToMediaChanges,
  type MediaAsset,
} from '../../../services/media';
import { analyzeImage } from '../../../services/ai';
import { AuroraBackground, PageTitleBlock } from '../../../components/ui';
import { Brand, Text as TText, Font, Radius } from '../../../utils/theme';
import type { Item } from '../../../drizzle/schema';
import Ionicons from '@expo/vector-icons/Ionicons';

const NUM_COLS = 3;
const GAP = 10;
const SCREEN_W = Dimensions.get('window').width;
const CELL = (SCREEN_W - GAP * (NUM_COLS + 1)) / NUM_COLS;

type ListItem = { type: 'add' } | { type: 'asset'; asset: MediaAsset };

function buildAddedMap(items: Item[]): Map<string, Item> {
  const m = new Map<string, Item>();
  for (const i of items) {
    if (i.sourceAssetId) m.set(i.sourceAssetId, i);
    m.set(i.imagePath, i);
  }
  return m;
}

function itemForAsset(added: Map<string, Item>, asset: MediaAsset): Item | undefined {
  // New rows namespace the system ID by platform; accept the original ID too
  // so rows created before namespacing still show their metadata badges.
  return added.get(`${Platform.OS}:${asset.id}`) ?? added.get(asset.id) ?? added.get(asset.uri);
}

// ─── 相册权限入口格 ───────────────────────────────────────────
function AddCell({ onPress }: { onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() =>
    Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 2 }).start(), []);
  const onPressOut = useCallback(() =>
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start(), []);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel="添加系统相册可访问照片"
    >
      <Animated.View style={[styles.cell, styles.addCell, { transform: [{ scale }] }]}>
        <Text style={styles.addIcon}>＋</Text>
        <Text style={styles.addLabel}>添加</Text>
      </Animated.View>
    </Pressable>
  );
}

// ─── 图片格 ───────────────────────────────────────────────────
function AssetCell({
  asset, item, selected, selecting, isVisible,
  onPress, onLongPress,
}: {
  asset: MediaAsset;
  item?: Item;
  selected: boolean;
  selecting: boolean;
  isVisible: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLocalUri(null);
    resolveLocalUri(asset.uri, { shouldDownloadFromNetwork: false })
      .then(async (u) => {
        if (cancelled) return;
        if (!u.startsWith('ph://')) { setLocalUri(u); return; }
        if (!isVisible) return;
        const downloaded = await resolveLocalUri(asset.uri);
        if (!cancelled) setLocalUri(downloaded.startsWith('ph://') ? null : downloaded);
      })
      .catch(() => { if (!cancelled) setLocalUri(null); });
    return () => { cancelled = true; };
  }, [asset.uri, isVisible]);

  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() =>
    Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 2 }).start(), []);
  const onPressOut = useCallback(() =>
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start(), []);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={[
        '照片',
        item ? '已入库' : '未入库',
        item?.analysis ? '已分析' : '未分析',
        item?.usedAt ? '已使用' : null,
        selected ? '已选中' : null,
      ].filter(Boolean).join('，')}
    >
      <Animated.View style={[styles.cell, { transform: [{ scale }] }]}>
        {localUri
          ? <Image source={{ uri: localUri }} style={styles.cellImage} onError={() => setLocalUri(null)} />
          : <View style={[styles.cellImage, { backgroundColor: '#ebebeb' }]} />
        }

        {/* 选中模式蒙层 */}
        {selecting && (
          <View style={[styles.selectOverlay, selected && styles.selectOverlayActive]}>
            <View style={[styles.selectCircle, selected && styles.selectCircleActive]}>
              {selected && <Text style={styles.selectMark}>✓</Text>}
            </View>
          </View>
        )}

        {/* 入库/分析共用左下角单标记；多选时仍显示，选中勾独立在右上角。 */}
        {item && (
          <View pointerEvents="none" style={styles.assetStatusBadge}>
            <Ionicons
              name={item.analysis ? 'sparkles' : 'bookmark-outline'}
              size={11}
              color={item.analysis ? '#FFD34E' : '#D1D5DB'}
            />
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

// ─── 底部操作栏 ────────────────────────────────────────────────
function ActionBar({
  count, onCancel, onDelete, onCreateNote, onAnalyze, analyzing, bottom,
}: {
  count: number;
  onCancel: () => void;
  onDelete: () => void;
  onCreateNote: () => void;
  onAnalyze: () => void;
  analyzing: boolean;
  bottom: number;
}) {
  return (
    <View style={[styles.actionBar, { paddingBottom: bottom + 12 }]}>
      <BlurView intensity={72} tint="systemMaterialLight" style={StyleSheet.absoluteFill} />
      <View style={styles.actionBg} />

      <View style={styles.actionRow}>
        <Pressable onPress={onCancel} style={styles.actionBtn}>
          <Text style={styles.actionBtnText}>取消</Text>
        </Pressable>
        <Text style={styles.actionCount}>{analyzing ? '分析中…' : `已选 ${count} 张`}</Text>
      </View>

      <View style={styles.actionBtns}>
        <Pressable onPress={onDelete} style={[styles.actionPill, styles.actionPillGhost, { minWidth: 72 }]}>
          <Text style={styles.actionPillGhostText}>移除</Text>
        </Pressable>

        <Pressable
          onPress={onAnalyze}
          disabled={analyzing || count === 0}
          style={[styles.actionPill, styles.actionPillGhost, analyzing && styles.actionPillBusy, { flex: 1 }]}
        >
          <Text style={styles.actionPillGhostText}>{analyzing ? '分析中…' : 'AI 分析'}</Text>
        </Pressable>

        <Pressable onPress={onCreateNote} style={[styles.actionPill, styles.actionPillPrimary, { flex: 1.2 }]}>
          <Text style={styles.actionPillPrimaryText}>创作笔记</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── 主屏 ──────────────────────────────────────────────────────
export default function LibraryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const items = useStore((s) => s.items);
  const recordAssetUse = useStore((s) => s.recordAssetUse);
  const markItemsUsed = useStore((s) => s.markItemsUsed);
  const deleteItem = useStore((s) => s.deleteItem);
  const updateItemAnalysis = useStore((s) => s.updateItemAnalysis);
  const addNote = useStore((s) => s.addNote);

  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [hasNextPage, setHasNextPage] = useState(true);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [isLimited, setIsLimited] = useState(false);

  // 多选状态
  const [selecting, setSelecting] = useState(false);
  const [selectedUris, setSelectedUris] = useState<Set<string>>(new Set());

  // 相册元数据状态筛选
  const [statusFilter, setStatusFilter] = useState<'all' | 'added' | 'analyzed' | 'todo' | 'used'>('all');

  // limited 提示条可关闭
  const [limitedDismissed, setLimitedDismissed] = useState(false);

  // 批量分析进行中
  const [batchAnalyzing, setBatchAnalyzing] = useState(false);
  const loadAssetsRef = useRef<((reset?: boolean) => Promise<void>) | null>(null);
  const [visibleAssetIds, setVisibleAssetIds] = useState<Set<string>>(new Set());
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const next = new Set(viewableItems.flatMap((token) => {
      const item = token.item as ListItem | undefined;
      return item?.type === 'asset' ? [item.asset.id] : [];
    }));
    setVisibleAssetIds((prev) => {
      if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
      return next;
    });
  }).current;

  const addedMap = buildAddedMap(items);

  const addedCount = assets.filter((a) => !!itemForAsset(addedMap, a)).length;
  const analyzedCount = assets.filter((a) => !!itemForAsset(addedMap, a)?.analysis).length;
  const unanalyzedCount = Math.max(addedCount - analyzedCount, 0);
  const usedCount = assets.filter((a) => !!itemForAsset(addedMap, a)?.usedAt).length;
  const filteredAssets = assets.filter((a) => {
    const item = itemForAsset(addedMap, a);
    if (statusFilter === 'added') return !!item;
    if (statusFilter === 'analyzed') return !!item?.analysis;
    if (statusFilter === 'todo') return !!item && !item.analysis;
    if (statusFilter === 'used') return !!item?.usedAt;
    return true;
  });

  // 上滑收起筛选行，下滑展开
  const [chromeVisible, setChromeVisible] = useState(true);
  const lastScrollY = useRef(0);

  async function loadAssets(reset = false) {
    if (!hasNextPage && !reset) return;
    try {
      const perm = await requestMediaPermission();
      if (!perm.granted) { setPermissionDenied(true); setLoading(false); return; }
      setPermissionDenied(false);
      setIsLimited(perm.limited);
      const cursor = reset ? undefined : endCursor;
      const result = await fetchAssets({ after: cursor, first: 36 });
      setAssets((prev) => reset ? result.assets : [...prev, ...result.assets]);
      setEndCursor(result.endCursor);
      setHasNextPage(result.hasNextPage);
    } catch (e: any) {
      Alert.alert('加载相册失败', e.message);
    } finally {
      setLoading(false);
    }
  }

  loadAssetsRef.current = loadAssets;

  useFocusEffect(useCallback(() => {
    void loadAssetsRef.current?.(true);
  }, []));

  useEffect(() => {
    const subscription = subscribeToMediaChanges(() => {
      void loadAssetsRef.current?.(true);
    });
    return () => subscription.remove();
  }, []);

  function exitSelecting() {
    setSelecting(false);
    setSelectedUris(new Set());
  }

  async function handleAddPress() {
    if (selecting) exitSelecting();
    await presentPermissionPicker();
    await loadAssets(true);
  }

  // 单击
  async function handleCellPress(asset: MediaAsset) {
    if (selecting) {
      // 选中模式：所有图片都可以切换选中状态
      setSelectedUris((prev) => {
        const next = new Set(prev);
        if (next.has(asset.uri)) next.delete(asset.uri);
        else next.add(asset.uri);
        return next;
      });
      return;
    }
    // 普通模式：已收录 → 查看应用侧元数据；否则明确触发一次图片分析。
    const item = itemForAsset(addedMap, asset);
    if (item) {
      router.push(`/(tabs)/library/${item.id}`);
      return;
    }
    try {
      const [newItem] = await recordAssetUse([
        { title: '新图片', imagePath: asset.uri, sourceAssetId: asset.id },
      ], 'image_analysis');
      readBase64FromAsset(asset)
        .then((b64) => analyzeImage(b64))
        .then((analysis) => updateItemAnalysis(newItem.id, analysis))
        .catch((e: any) => {
          console.warn('analyzeImage failed', e);
          Alert.alert('图片分析失败', e?.message ?? '未知错误');
        });
    } catch (e: any) {
      Alert.alert('添加失败', e.message);
    }
  }

  // 长按：进入选中模式，选中系统相册中的照片（无论是否已有应用记录）
  function handleCellLongPress(asset: MediaAsset) {
    setSelecting(true);
    setSelectedUris(new Set([asset.uri]));
  }

  // 删除（仅删除应用侧标记，不修改系统照片）
  function handleDelete() {
    const selectedItems = Array.from(selectedUris)
      .map((uri) => {
        const asset = assets.find((candidate) => candidate.uri === uri);
        return asset ? itemForAsset(addedMap, asset) : addedMap.get(uri);
      })
      .filter(Boolean) as Item[];
    Alert.alert(
      '移除照片标记',
      selectedItems.length > 0
        ? `确认移除 ${selectedItems.length} 张照片的应用侧记录？系统相册中的照片不会删除。`
        : '所选照片尚无应用侧记录。',
      selectedItems.length > 0
        ? [
            { text: '取消', style: 'cancel' },
            {
              text: '移除记录', style: 'destructive',
              onPress: async () => {
                for (const item of selectedItems) await deleteItem(item.id);
                exitSelecting();
              },
            },
          ]
        : [{ text: '好的' }]
    );
  }

  // 批量分析只为这次实际提交的照片创建/复用元数据记录。
  async function handleBatchAnalyze() {
    if (selectedUris.size === 0 || batchAnalyzing) return;
    setBatchAnalyzing(true);
    let ok = 0;
    let fail = 0;
    try {
      const selectedAssets = Array.from(selectedUris)
        .map((uri) => assets.find((asset) => asset.uri === uri))
        .filter(Boolean) as MediaAsset[];
      const tracked = await recordAssetUse(selectedAssets.map((asset) => ({
        imagePath: asset.uri,
        sourceAssetId: asset.id,
      })), 'image_analysis');
      for (let index = 0; index < selectedAssets.length; index += 1) {
        try {
          const asset = selectedAssets[index];
          const item = tracked[index];
          const b64 = await readBase64FromAsset(asset);
          const analysis = await analyzeImage(b64);
          if (analysis) {
            await updateItemAnalysis(item.id, analysis);
            ok += 1;
          } else {
            fail += 1;
          }
        } catch (e) {
          console.warn('batch analyze failed', e);
          fail += 1;
        }
      }
    } finally {
      setBatchAnalyzing(false);
    }
    Alert.alert('批量分析完成', `成功 ${ok} 张${fail ? `，失败 ${fail} 张` : ''}`);
  }

  // 创作笔记：实际关联到笔记的照片才创建/复用应用侧记录。
  async function handleCreateNote() {
    if (selectedUris.size === 0) return;
    try {
      const selectedAssets = Array.from(selectedUris)
        .map((uri) => assets.find((asset) => asset.uri === uri))
        .filter(Boolean) as MediaAsset[];
      const wasStored = selectedAssets.map((asset) => !!itemForAsset(addedMap, asset));
      const selectedItems = await recordAssetUse(selectedAssets.map((asset) => ({
        imagePath: asset.uri,
        sourceAssetId: asset.id,
      })), 'note_attachment');
      const itemIds = selectedItems.map((item) => item.id);
      const newUnanalyzedIds = selectedItems.filter((item, index) => !wasStored[index] && !item.analysis).map((item) => item.id);
      if (newUnanalyzedIds.length > 0) await markItemsUsed(newUnanalyzedIds, 'image_analysis');
      for (let index = 0; index < selectedAssets.length; index += 1) {
        if (wasStored[index] || selectedItems[index].analysis) continue;
        const asset = selectedAssets[index];
        const item = selectedItems[index];
        readBase64FromAsset(asset)
          .then((b64) => analyzeImage(b64))
          .then((analysis) => updateItemAnalysis(item.id, analysis))
          .catch((e) => console.warn('analyzeImage failed', e));
      }
      const note = await addNote({ itemIds });
      exitSelecting();
      // 先切到创作 tab，再推入编辑页
      router.navigate('/(tabs)/create');
      setTimeout(() => {
        router.push(`/(tabs)/create/edit/${note.id}`);
      }, 80);
    } catch (e: any) {
      Alert.alert('创作失败', e.message);
    }
  }

  const listData: ListItem[] = [
    { type: 'add' },
    ...filteredAssets.map((asset) => ({ type: 'asset' as const, asset })),
  ];

  const extraData = { selectedUris, selecting, visibleAssetIds };

  function renderItem({ item }: { item: ListItem }) {
    if (item.type === 'add') return <AddCell onPress={() => void handleAddPress()} />;
    const { asset } = item;
    return (
      <AssetCell
        asset={asset}
        item={itemForAsset(addedMap, asset)}
        selected={selectedUris.has(asset.uri)}
        selecting={selecting}
        isVisible={visibleAssetIds.has(asset.id)}
        onPress={() => handleCellPress(asset)}
        onLongPress={() => handleCellLongPress(asset)}
      />
    );
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />

      {/* 标题行 + 筛选 — 与创作页同一结构（filter 在 PageTitleBlock children） */}
      <PageTitleBlock
        title={selecting ? '选择照片' : '相册'}
        count={selecting ? selectedUris.size : assets.length}
        right={
          !selecting ? (
            <Pressable
              style={styles.aiChatEntry}
              onPress={() => router.push({ pathname: '/(tabs)/create/chat', params: { from: 'library' } })}
            >
              <Text style={styles.aiChatEntryIcon}>✦</Text>
              <Text style={styles.aiChatEntryText}>AI 对话</Text>
            </Pressable>
          ) : null
        }
      >
        {!selecting && !permissionDenied && chromeVisible && (
          <ScrollView
            horizontal
            style={styles.filterScroll}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {([
              { key: 'all', label: '全部', n: assets.length },
              { key: 'added', label: '已入库', n: addedCount },
              { key: 'analyzed', label: '已分析', n: analyzedCount },
              { key: 'todo', label: '未分析', n: unanalyzedCount },
              { key: 'used', label: '已使用', n: usedCount },
            ] as const).map((f) => {
              const active = statusFilter === f.key;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setStatusFilter(f.key)}
                  style={styles.filterTab}
                >
                  <Text style={[styles.filterTabText, active && styles.filterTabTextActive]} numberOfLines={1}>
                    {f.label} {f.n}
                  </Text>
                  <View style={[styles.filterTabLine, active && styles.filterTabLineActive]} />
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </PageTitleBlock>

      {/* limited 权限提示条 */}
      {isLimited && !selecting && !limitedDismissed && (
        <View style={styles.limitedBanner}>
          <Pressable style={styles.limitedMain} onPress={handleAddPress}>
            <Text style={styles.limitedText}>
              仅显示部分照片，可到设置开启完整相册，点击管理访问权限 →
            </Text>
          </Pressable>
          <Pressable
            style={styles.limitedClose}
            hitSlop={8}
            onPress={() => setLimitedDismissed(true)}
          >
            <Text style={styles.limitedCloseText}>×</Text>
          </Pressable>
        </View>
      )}

      {permissionDenied ? (
        <View style={styles.center}>
          <Text style={styles.hintText}>需要照片访问权限才能浏览相册</Text>
          <Pressable onPress={openAppSettings} style={styles.settingsBtn}>
            <Text style={styles.settingsBtnText}>去设置开启</Text>
          </Pressable>
        </View>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Brand.red} />
        </View>
      ) : (
        <FlatList
          data={listData}
          keyExtractor={(item) => item.type === 'add' ? '__permission_add__' : item.asset.id}
          renderItem={renderItem}
          numColumns={NUM_COLS}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          showsVerticalScrollIndicator={false}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            const dy = y - lastScrollY.current;
            if (dy > 8 && y > 24) {
              if (chromeVisible) setChromeVisible(false);
            } else if (dy < -8 || y < 8) {
              if (!chromeVisible) setChromeVisible(true);
            }
            lastScrollY.current = y;
          }}
          scrollEventThrottle={32}
          onEndReached={() => loadAssets()}
          onEndReachedThreshold={0.4}
          initialNumToRender={12}
          maxToRenderPerBatch={9}
          windowSize={5}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          extraData={extraData}
          ListHeaderComponent={
            assets.length === 0 && !loading ? (
              <View style={styles.emptyHint}>
                <Text style={styles.emptyHintText}>
                  当前权限范围内没有可显示的照片
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            hasNextPage ? <ActivityIndicator color={Brand.red} style={{ marginVertical: 16 }} /> : null
          }
        />
      )}

      {/* 底部操作栏（选中模式） */}
      {selecting && (
        <ActionBar
          count={selectedUris.size}
          onCancel={exitSelecting}
          onDelete={handleDelete}
          onCreateNote={handleCreateNote}
          onAnalyze={() => void handleBatchAnalyze()}
          analyzing={batchAnalyzing}
          bottom={insets.bottom + 80} // 80 = tab bar 高度
        />
      )}
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  grid: { paddingTop: 8, paddingHorizontal: GAP, paddingBottom: 110 },
  row: { gap: GAP, marginBottom: GAP },

  // ── 标题行右侧 AI 对话入口（红色主题）──
  aiChatEntry: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: Brand.red,
  },
  aiChatEntryIcon: { fontSize: 11, color: '#fff', fontWeight: '700' },
  aiChatEntryText: { fontSize: Font.caption, color: '#fff', fontWeight: Font.semibold },

  // ── 筛选文字 tab（固定高度，避免横向 ScrollView 纵向裁切）──
  filterScroll: {
    width: '100%',
    height: 42,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 42,
    gap: 18,
    // 横向 padding 由 PageTitleBlock 提供（18），这里不再叠加
    paddingRight: 4,
  },
  filterTab: {
    height: 42,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  filterTabText: {
    fontSize: 13, color: TText.secondary, fontWeight: '500',
    flexShrink: 0,
    lineHeight: 18,
  },
  filterTabTextActive: { color: Brand.red, fontWeight: '600' },
  filterTabLine: {
    height: 2, alignSelf: 'stretch', borderRadius: 1,
    backgroundColor: 'transparent',
  },
  filterTabLineActive: { backgroundColor: Brand.red },

  // ── 图片格 ──────────────────────────────────────────────────
  cell: { position: 'relative', width: CELL, height: CELL, overflow: 'hidden', backgroundColor: '#e5e5e5' },
  cellImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  addCell: {
    backgroundColor: '#fff0f2',
    borderWidth: 1.5, borderColor: Brand.red, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  addIcon: { fontSize: 26, color: Brand.red, lineHeight: 30 },
  addLabel: { fontSize: Font.caption, color: Brand.red, fontWeight: '600' },
  assetStatusBadge: {
    position: 'absolute', bottom: 5, left: 5, zIndex: 10,
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(24,24,27,0.66)',
  },

  // ── 选中模式蒙层 ─────────────────────────────────────────────
  selectOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'flex-end', justifyContent: 'flex-start', padding: 5,
  },
  selectOverlayActive: {
    backgroundColor: 'rgba(255,36,66,0.09)',
    borderWidth: 2, borderColor: Brand.red,
  },
  selectCircle: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  selectCircleActive: { backgroundColor: Brand.red, borderColor: Brand.red },
  selectMark: { color: '#fff', fontSize: 12, fontWeight: '700' },

  // ── limited 权限条 ───────────────────────────────────────────
  limitedBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fffbeb',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#fcd34d',
  },
  limitedMain: { flex: 1, paddingVertical: 10, paddingHorizontal: 14 },
  limitedText: {
    fontSize: Font.footnote, color: '#92400e',
    textAlign: 'left', lineHeight: 18,
  },
  limitedClose: { paddingHorizontal: 12, paddingVertical: 9 },
  limitedCloseText: { fontSize: 18, color: '#92400e', lineHeight: 20 },

  // ── 权限拒绝 ─────────────────────────────────────────────────
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  hintText: { fontSize: Font.body, color: TText.secondary, textAlign: 'center', paddingHorizontal: 32 },
  settingsBtn: { paddingHorizontal: 24, paddingVertical: 10, backgroundColor: Brand.red, borderRadius: Radius.md },
  settingsBtnText: { color: '#fff', fontSize: Font.subheadline, fontWeight: '600' },

  // ── 底部操作栏 ───────────────────────────────────────────────
  actionBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(0,0,0,0.08)',
  },
  actionBg: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  actionBtn: { paddingVertical: 6, paddingHorizontal: 4, minWidth: 36 },
  actionBtnText: { fontSize: Font.subheadline, color: TText.secondary },
  actionCount: {
    flex: 1, textAlign: 'right',
    fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary,
  },
  actionBtns: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  actionPill: {
    paddingHorizontal: 12, paddingVertical: 11,
    borderRadius: Radius.pill,
    alignItems: 'center', justifyContent: 'center',
    minWidth: 72,
  },
  actionPillGhost: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' },
  actionPillBusy: { opacity: 0.5 },
  actionPillGhostText: { fontSize: Font.subheadline, color: TText.secondary, fontWeight: Font.medium },
  actionPillPrimary: { backgroundColor: Brand.red },
  actionPillPrimaryText: { fontSize: Font.subheadline, color: '#fff', fontWeight: Font.semibold },
  emptyHint: { paddingVertical: 24, paddingHorizontal: 16, alignItems: 'center' },
  emptyHintText: { fontSize: Font.footnote, color: TText.tertiary, textAlign: 'center', lineHeight: 22 },
});
