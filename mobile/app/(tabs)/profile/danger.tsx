import {
  View, Text, ScrollView, Pressable,
  StyleSheet, Alert,
} from 'react-native';
import { useStore } from '../../../store';
import { AuroraBackground } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius, Sys } from '../../../utils/theme';

function DangerRow({
  icon, label, desc, onPress, last = false,
}: {
  icon: string;
  label: string;
  desc: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.rowLeft}>
          <Text style={styles.rowIcon}>{icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowDesc}>{desc}</Text>
          </View>
        </View>
      </Pressable>
      {!last && <View style={styles.divider} />}
    </>
  );
}

export default function DangerScreen() {
  const items = useStore((s) => s.items);
  const notes = useStore((s) => s.notes);
  const clearItems = useStore((s) => s.clearItems);
  const deleteNote = useStore((s) => s.deleteNote);

  async function handleClearItems() {
    if (items.length === 0) { Alert.alert('图库已是空的'); return; }
    Alert.alert(
      '清空图库记录',
      `确认删除全部 ${items.length} 条记录？\n不会删除手机相册里的图片。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '清空', style: 'destructive', onPress: () => clearItems() },
      ]
    );
  }

  async function handleClearDrafts() {
    const drafts = notes.filter((n) => n.status !== 'ready');
    if (drafts.length === 0) { Alert.alert('没有草稿'); return; }
    Alert.alert(
      '清空草稿',
      `确认删除全部 ${drafts.length} 篇草稿？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清空', style: 'destructive', onPress: async () => {
            for (const n of drafts) await deleteNote(n.id);
          },
        },
      ]
    );
  }

  async function handleClearAll() {
    Alert.alert(
      '清空所有数据',
      '确认删除所有图库记录、草稿和笔记？此操作不可撤销。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '全部清空', style: 'destructive', onPress: async () => {
            await clearItems();
            for (const n of notes) await deleteNote(n.id);
          },
        },
      ]
    );
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

        {/* 当前数据量概览 */}
        <View style={styles.statsRow}>
          <View style={styles.statChip}>
            <Text style={styles.statNum}>{items.length}</Text>
            <Text style={styles.statLabel}>图库记录</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statNum}>{notes.filter(n => n.status !== 'ready').length}</Text>
            <Text style={styles.statLabel}>草稿</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statNum}>{notes.filter(n => n.status === 'ready').length}</Text>
            <Text style={styles.statLabel}>待发布</Text>
          </View>
        </View>

        <Text style={styles.groupLabel}>清理操作</Text>
        <View style={styles.card}>
          <DangerRow
            icon="🖼️"
            label="清空图库记录"
            desc={`删除 ${items.length} 条记录，不删除手机相册图片`}
            onPress={handleClearItems}
          />
          <DangerRow
            icon="📝"
            label="清空草稿"
            desc={`删除 ${notes.filter(n => n.status !== 'ready').length} 篇未完成草稿`}
            onPress={handleClearDrafts}
            last
          />
        </View>

        <Text style={styles.groupLabel}>危险操作</Text>
        <View style={[styles.card, styles.dangerCard]}>
          <DangerRow
            icon="⚠️"
            label="清空所有数据"
            desc="删除图库、草稿、笔记全部本地数据"
            onPress={handleClearAll}
            last
          />
        </View>

        <Text style={styles.note}>
          以上操作仅清除 App 内的记录，不会影响手机相册中的原始图片。
        </Text>
      </ScrollView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12 },

  // ── 概览 ────────────────────────────────────────────────────
  statsRow: {
    flexDirection: 'row', gap: 10, marginBottom: 4,
  },
  statChip: {
    flex: 1, backgroundColor: '#fff',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Glass.border,
    alignItems: 'center', paddingVertical: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 3,
  },
  statNum: { fontSize: Font.title2, fontWeight: Font.bold, color: TText.primary },
  statLabel: { fontSize: Font.caption, color: TText.tertiary, marginTop: 2 },

  // ── 分组标签 ────────────────────────────────────────────────
  groupLabel: {
    fontSize: Font.footnote, fontWeight: Font.semibold, color: TText.tertiary,
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 4, paddingHorizontal: 4,
  },

  // ── 卡片 ────────────────────────────────────────────────────
  card: {
    backgroundColor: '#fff',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4,
  },
  dangerCard: { borderColor: 'rgba(255,36,66,0.2)' },

  // ── 行 ──────────────────────────────────────────────────────
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  rowPressed: { backgroundColor: 'rgba(0,0,0,0.04)' },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  rowIcon: { fontSize: 20, width: 26, textAlign: 'center' },
  rowLabel: { fontSize: Font.body, color: Brand.red, fontWeight: Font.medium },
  rowDesc: { fontSize: Font.caption, color: TText.tertiary, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Glass.borderSubtle, marginLeft: 52 },

  // ── 底部说明 ─────────────────────────────────────────────────
  note: {
    fontSize: Font.caption, color: TText.tertiary,
    textAlign: 'center', lineHeight: 18, paddingHorizontal: 8,
    marginTop: 4,
  },
});
