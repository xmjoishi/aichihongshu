import {
  View,
  Text,
  FlatList,
  Image,
  StyleSheet,
  Alert,
  Dimensions,
  StatusBar,
  Pressable,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
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
  type MediaAsset,
} from '../../../services/media';
import { analyzeImage } from '../../../services/ai';
import { AuroraBackground } from '../../../components/ui';
import { Brand, Text as TText, Font, Radius, Border } from '../../../utils/theme';
import type { Item } from '../../../drizzle/schema';

const NUM_COLS = 3;
const GAP = 2;
const SCREEN_W = Dimensions.get('window').width;
const CELL = (SCREEN_W - GAP * (NUM_COLS + 1)) / NUM_COLS;

type ListItem = { type: 'add' } | { type: 'asset'; asset: MediaAsset };

function buildAddedMap(items: Item[]): Map<string, Item> {
  const m = new Map<string, Item>();
  for (const i of items) {
    if (i.imagePath.startsWith('ph://') || i.imagePath.startsWith('file://')) {
      m.set(i.imagePath, i);
    }
  }
  return m;
}

// ─── "+" 添加格 ────────────────────────────────────────────────
function AddCell({ onPress }: { onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() =>
    Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 2 }).start(), []);
  const onPressOut = useCallback(() =>
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start(), []);
  return (
    <Pressable onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut}>
      <Animated.View style={[styles.cell, styles.addCell, { transform: [{ scale }] }]}>
        <Text style={styles.addIcon}>＋</Text>
        <Text style={styles.addLabel}>添加</Text>
      </Animated.View>
    </Pressable>
  );
}

// ─── 图片格 ───────────────────────────────────────────────────
function AssetCell({
  asset, selected, selecting,
  onPress, onLongPress,
}: {
  asset: MediaAsset;
  selected: boolean;
  selecting: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveLocalUri(asset.uri).then((u) => { if (!cancelled) setLocalUri(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [asset.uri]);

  const scale = useRef(new Animated.Value(1)).current;
  const onPressIn = useCallback(() =>
    Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 2 }).start(), []);
  const onPressOut = useCallback(() =>
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start(), []);

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} onPressIn={onPressIn} onPressOut={onPressOut} delayLongPress={350}>
      <Animated.View style={[styles.cell, { transform: [{ scale }] }]}>
        {localUri
          ? <Image source={{ uri: localUri }} style={styles.cellImage} />
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
      </Animated.View>
    </Pressable>
  );
}

// ─── 底部操作栏 ────────────────────────────────────────────────
function ActionBar({
  count, onCancel, onDelete, onCreateNote, bottom,
}: {
  count: number;
  onCancel: () => void;
  onDelete: () => void;
  onCreateNote: () => void;
  bottom: number;
}) {
  return (
    <View style={[styles.actionBar, { paddingBottom: bottom + 12 }]}>
      <BlurView intensity={72} tint="systemMaterialLight" style={StyleSheet.absoluteFill} />
      <View style={styles.actionBg} />

      <View style={styles.actionRow}>
        {/* 取消 */}
        <Pressable onPress={onCancel} style={styles.actionBtn}>
          <Text style={styles.actionBtnText}>取消</Text>
        </Pressable>

        {/* 已选数量 */}
        <Text style={styles.actionCount}>已选 {count} 张</Text>

        {/* 操作按钮组 */}
        <View style={styles.actionBtns}>
          {/* 删除（预留） */}
          <Pressable onPress={onDelete} style={[styles.actionPill, styles.actionPillGhost]}>
            <Text style={styles.actionPillGhostText}>删除</Text>
          </Pressable>

          {/* 创作笔记 */}
          <Pressable onPress={onCreateNote} style={[styles.actionPill, styles.actionPillPrimary]}>
            <Text style={styles.actionPillPrimaryText}>创作笔记</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ─── 主屏 ──────────────────────────────────────────────────────
export default function LibraryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const items = useStore((s) => s.items);
  const addItem = useStore((s) => s.addItem);
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

  const addedMap = buildAddedMap(items);

  async function loadAssets(reset = false) {
    if (!hasNextPage && !reset) return;
    try {
      const perm = await requestMediaPermission();
      if (!perm.granted) { setPermissionDenied(true); setLoading(false); return; }
      setIsLimited(perm.limited);
      const cursor = reset ? undefined : endCursor;
      const result = await fetchAssets({ after: cursor, first: 60 });
      setAssets((prev) => reset ? result.assets : [...prev, ...result.assets]);
      setEndCursor(result.endCursor);
      setHasNextPage(result.hasNextPage);
    } catch (e: any) {
      Alert.alert('加载相册失败', e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAssets(true); }, []);

  function exitSelecting() {
    setSelecting(false);
    setSelectedUris(new Set());
  }

  // "+" 格
  async function handleAddPress() {
    if (selecting) { exitSelecting(); return; }
    await presentPermissionPicker();
    setTimeout(() => loadAssets(true), 500);
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
    // 普通模式：已在图库 → 跳详情；否则 → 加入图库
    const item = addedMap.get(asset.uri);
    if (item) {
      router.push(`/(tabs)/library/${item.id}`);
      return;
    }
    try {
      const newItem = await addItem({ title: '新图片', imagePath: asset.uri });
      readBase64FromAsset(asset)
        .then((b64) => analyzeImage(b64))
        .then((analysis) => updateItemAnalysis(newItem.id, analysis))
        .catch(console.warn);
    } catch (e: any) {
      Alert.alert('添加失败', e.message);
    }
  }

  // 长按：进入选中模式，选中该图片（无论是否已加入图库）
  function handleCellLongPress(asset: MediaAsset) {
    setSelecting(true);
    setSelectedUris(new Set([asset.uri]));
  }

  // 删除（仅删除已入库的记录，未入库的直接从选中集合移除）
  function handleDelete() {
    const addedCount = Array.from(selectedUris).filter((uri) => addedMap.has(uri)).length;
    Alert.alert(
      '删除图库记录',
      addedCount > 0
        ? `确认从图库中删除已选的 ${addedCount} 条记录？（不会删除手机相册里的图片）`
        : '所选图片尚未加入图库，无需删除。',
      addedCount > 0
        ? [
            { text: '取消', style: 'cancel' },
            {
              text: '删除', style: 'destructive',
              onPress: async () => {
                for (const uri of selectedUris) {
                  const item = addedMap.get(uri);
                  if (item) await deleteItem(item.id);
                }
                exitSelecting();
              },
            },
          ]
        : [{ text: '好的' }]
    );
  }

  // 创作笔记：选中图片自动入库（如果还没入库），再创建笔记
  async function handleCreateNote() {
    if (selectedUris.size === 0) return;
    try {
      const itemIds: number[] = [];
      for (const uri of selectedUris) {
        let item = addedMap.get(uri);
        if (!item) {
          // 自动入库
          const asset = assets.find((a) => a.uri === uri);
          item = await addItem({ title: '新图片', imagePath: uri });
          if (asset) {
            readBase64FromAsset(asset)
              .then((b64) => analyzeImage(b64))
              .then((analysis) => updateItemAnalysis(item!.id, analysis))
              .catch(console.warn);
          }
        }
        itemIds.push(item.id);
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
    ...assets.map((a) => ({ type: 'asset' as const, asset: a })),
  ];

  const extraData = { selectedUris, selecting };

  function renderItem({ item }: { item: ListItem }) {
    if (item.type === 'add') return <AddCell onPress={handleAddPress} />;
    const { asset } = item;
    return (
      <AssetCell
        asset={asset}
        selected={selectedUris.has(asset.uri)}
        selecting={selecting}
        onPress={() => handleCellPress(asset)}
        onLongPress={() => handleCellLongPress(asset)}
      />
    );
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />

      {/* 标题行 */}
      <View style={[styles.pageHeader, { paddingTop: insets.top + 8 }]}>
        {selecting ? (
          <Text style={styles.pageTitle}>选择图片</Text>
        ) : (
          <>
            <Text style={styles.pageTitle}>图库</Text>
            <Text style={styles.pageSubtitle}>{items.length} 张已添加</Text>
          </>
        )}
      </View>

      {/* limited 权限提示条 */}
      {isLimited && !selecting && (
        <Pressable style={styles.limitedBanner} onPress={handleAddPress}>
          <Text style={styles.limitedText}>仅显示部分照片  点击管理访问权限 →</Text>
        </Pressable>
      )}

      {permissionDenied ? (
        <View style={styles.center}>
          <Text style={styles.hintText}>需要相册权限才能使用图库</Text>
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
          keyExtractor={(item) => item.type === 'add' ? '__add__' : item.asset.id}
          renderItem={renderItem}
          numColumns={NUM_COLS}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          showsVerticalScrollIndicator={false}
          onEndReached={() => loadAssets()}
          onEndReachedThreshold={0.4}
          extraData={extraData}
          ListHeaderComponent={
            assets.length === 0 && !loading ? (
              <View style={styles.emptyHint}>
                <Text style={styles.emptyHintText}>
                  相册为空或没有找到图片{'\n'}点击「+」选择图片加入图库
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
          bottom={insets.bottom + 80} // 80 = tab bar 高度
        />
      )}
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  pageHeader: { paddingHorizontal: 18, paddingBottom: 8 },
  pageTitle: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary },
  pageSubtitle: { fontSize: Font.caption, color: TText.tertiary, marginTop: 1 },

  grid: { paddingTop: GAP, paddingHorizontal: GAP, paddingBottom: 110 },
  row: { gap: GAP, marginBottom: GAP },

  // ── 图片格 ──────────────────────────────────────────────────
  cell: { width: CELL, height: CELL, overflow: 'hidden', backgroundColor: '#e5e5e5' },
  cellImage: { width: '100%', height: '100%', resizeMode: 'cover' },

  // ── "+" 添加格 ──────────────────────────────────────────────
  addCell: {
    backgroundColor: '#fff0f2',
    borderWidth: 1.5, borderColor: Brand.red, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  addIcon: { fontSize: 26, color: Brand.red, lineHeight: 30 },
  addLabel: { fontSize: Font.caption, color: Brand.red, fontWeight: '600' },

  // ── 选中模式蒙层 ─────────────────────────────────────────────
  selectOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'flex-end', justifyContent: 'flex-start', padding: 5,
  },
  selectOverlayActive: {
    backgroundColor: 'rgba(255,36,66,0.22)',
    borderWidth: 2.5, borderColor: Brand.red,
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
    backgroundColor: '#fffbeb',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#fcd34d',
    paddingVertical: 9, paddingHorizontal: 16,
  },
  limitedText: { fontSize: Font.footnote, color: '#92400e', textAlign: 'center' },

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
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  actionBtn: { paddingVertical: 6, paddingHorizontal: 4, minWidth: 36 },
  actionBtnText: { fontSize: Font.subheadline, color: TText.secondary },
  actionCount: { flex: 1, textAlign: 'center', fontSize: Font.subheadline, fontWeight: Font.semibold, color: TText.primary },
  actionBtns: { flexDirection: 'row', gap: 8 },
  actionPill: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  actionPillGhost: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' },
  actionPillGhostText: { fontSize: Font.subheadline, color: TText.secondary, fontWeight: Font.medium },
  actionPillPrimary: { backgroundColor: Brand.red },
  actionPillPrimaryText: { fontSize: Font.subheadline, color: '#fff', fontWeight: Font.semibold },
  emptyHint: { paddingVertical: 24, paddingHorizontal: 16, alignItems: 'center' },
  emptyHintText: { fontSize: Font.footnote, color: TText.tertiary, textAlign: 'center', lineHeight: 22 },
});
