import {
  View, Text, ScrollView, TextInput, Pressable,
  StyleSheet, Alert, Image, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { AuroraBackground, InlineNav, LiquidButton, LiquidCard, GlassBackBar } from '../../../components/ui';
import { Brand, Text as TText, Font, Radius } from '../../../utils/theme';
import { getImageAssetReference } from '../../../services/media';
import { useStore } from '../../../store';
import {
  createPcHarnessClient,
  type CompanionDraft,
  type CompanionPhoto,
  type CompanionTask,
} from '../../../services/pcHarness';

export default function PcCompanionScreen() {
  const router = useRouter();
  const recordAssetUse = useStore((s) => s.recordAssetUse);
  const [photos, setPhotos] = useState<Array<CompanionPhoto & { assetId?: string | null }>>([]);
  const [topic, setTopic] = useState('');
  const [task, setTask] = useState<CompanionTask | null>(null);
  const [draft, setDraft] = useState<CompanionDraft | null>(null);
  const [noteUrl, setNoteUrl] = useState('');
  const [busy, setBusy] = useState(false);

  async function pickPhotos(useCamera: boolean) {
    const result = useCamera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: 0.9 });
    if (result.canceled) return;
    setPhotos((current) => [
      ...current,
        ...result.assets.map((asset, index) => ({
          uri: asset.uri,
          assetId: asset.assetId,
          filename: asset.fileName ?? `photo-${current.length + index + 1}.jpg`,
        mimeType: asset.mimeType ?? 'image/jpeg',
      })),
    ]);
  }

  async function sendToPc() {
    setBusy(true);
    try {
      const client = await createPcHarnessClient();
      if (!client) throw new Error('请先在设置中完成 PC Harness 配对');
      const clientTaskId = `mobile-${Date.now()}`;
      const created = await client.createTask({
        photos: photos.map(({ assetId: _assetId, ...photo }) => photo),
        topic,
        clientTaskId,
      });
      void Promise.all(photos.map((photo) => getImageAssetReference(photo.assetId, photo.uri)))
        .then((photoReferences) => recordAssetUse(photoReferences.map((reference) => ({ ...reference, title: '新图片' })), 'pc_harness'))
        .catch((error) => console.warn('record PC Harness photo use failed', error));
      setTask(created);
      setDraft(null);
      const finished = await client.waitForTask(created.taskId);
      setTask(finished);
      if (finished.status === 'failed') {
        throw new Error(finished.error ?? 'PC 任务失败');
      }
      if (finished.status === 'ready') {
        setDraft(await client.getDraft(finished.taskId));
        Alert.alert('PC 已出稿', '可在下方查看稿件；人工发布后回填链接。');
      } else {
        Alert.alert('已发送到 PC', `任务 ${finished.taskId} 状态：${finished.status}`);
      }
    } catch (error) {
      Alert.alert('发送失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pullDraft() {
    if (!task) return;
    setBusy(true);
    try {
      const client = await createPcHarnessClient();
      if (!client) throw new Error('PC Harness 尚未配对');
      const status = await client.getTask(task.taskId);
      setTask(status);
      if (status.status === 'failed') throw new Error(status.error ?? 'PC 任务失败');
      if (status.status !== 'ready') return;
      setDraft(await client.getDraft(task.taskId));
    } catch (error) {
      Alert.alert('拉取稿件失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendReceipt(status: 'submitted' | 'confirmed' | 'unknown') {
    if (!task) return;
    setBusy(true);
    try {
      const client = await createPcHarnessClient();
      if (!client) throw new Error('PC Harness 尚未配对');
      const next = await client.recordPublishReceipt(task.taskId, {
        status,
        noteUrl: noteUrl.trim() || undefined,
        occurredAt: new Date().toISOString(),
      });
      setTask(next);
      Alert.alert('已回填 PC', status === 'confirmed' ? '发布结果已确认。' : '发布状态已回填。');
    } catch (error) {
      Alert.alert('回填失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={ { headerShown: false } } />
          <AuroraBackground style={{ flex: 1 }}>
      <GlassBackBar title="PC Companion" backLabel="返回" onBack={() => router.back()} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <LiquidCard style={styles.card}>
          <Text style={styles.eyebrow}>手机输入 → PC 出稿</Text>
          <Text style={styles.title}>拍照和写主题，交给 PC Harness 继续处理</Text>
          <Text style={styles.desc}>手机端只提交当前任务；相册照片和笔记仍由 PC 管理。手机记忆以手机为事实源；PC 在线修改会发到手机保存，再同步更新 PC 缓存。PC 记忆不会下发到手机。</Text>
          <View style={styles.photoActions}>
            <Pressable onPress={() => void pickPhotos(true)} style={styles.secondaryButton}><Text style={styles.secondaryText}>拍照</Text></Pressable>
            <Pressable onPress={() => void pickPhotos(false)} style={styles.secondaryButton}><Text style={styles.secondaryText}>从相册选图</Text></Pressable>
          </View>
          {photos.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoRow}>
              {photos.map((photo, index) => <Image key={`${photo.uri}-${index}`} source={{ uri: photo.uri }} style={styles.photo} />)}
            </ScrollView>
          )}
          <TextInput
            value={topic}
            onChangeText={setTopic}
            placeholder="主题或真实经历，例如：出租房油烟机避坑"
            placeholderTextColor={TText.tertiary}
            multiline
            style={[styles.input, styles.topicInput]}
          />
          <LiquidButton label={busy ? '处理中…' : '上传到 PC Harness'} onPress={() => void sendToPc()} disabled={busy || (!topic.trim() && photos.length === 0)} />
        </LiquidCard>

        {task && (
          <LiquidCard style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>PC 任务</Text>
              <Text style={styles.status}>{task.status}</Text>
            </View>
            <Text style={styles.taskId}>任务 ID：{task.taskId}</Text>
            <Pressable onPress={() => void pullDraft()} disabled={busy} style={styles.outlineButton}>
              {busy ? <ActivityIndicator size="small" color={Brand.red} /> : null}
              <Text style={styles.outlineText}>拉取最新稿件</Text>
            </Pressable>
            {task.error ? <Text style={styles.error}>{task.error}</Text> : null}
          </LiquidCard>
        )}

        {draft && (
          <LiquidCard style={styles.card}>
            <Text style={styles.sectionTitle}>PC 生成稿</Text>
            <Text style={styles.draftTitle}>{draft.title || '（无标题）'}</Text>
            <Text style={styles.draftBody}>{draft.body || '（无正文）'}</Text>
            {draft.tags.length > 0 ? <Text style={styles.tags}>{draft.tags.map((tag) => `#${tag}`).join(' ')}</Text> : null}
            <Text style={styles.hint}>稿件仍以 PC 端笔记为准；手机这里用于查看和发布后回填。</Text>
          </LiquidCard>
        )}

        {task && (
          <LiquidCard style={styles.card}>
            <Text style={styles.sectionTitle}>发布结果回填</Text>
            <TextInput
              value={noteUrl}
              onChangeText={setNoteUrl}
              placeholder="发布后的笔记链接（可选）"
              placeholderTextColor={TText.tertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <View style={styles.receiptRow}>
              <Pressable onPress={() => void sendReceipt('submitted')} disabled={busy} style={styles.receiptButton}><Text style={styles.receiptText}>已提交</Text></Pressable>
              <Pressable onPress={() => void sendReceipt('unknown')} disabled={busy} style={styles.receiptButton}><Text style={styles.receiptText}>结果不明</Text></Pressable>
              <Pressable onPress={() => void sendReceipt('confirmed')} disabled={busy} style={[styles.receiptButton, styles.receiptPrimary]}><Text style={styles.receiptPrimaryText}>确认发布</Text></Pressable>
            </View>
          </LiquidCard>
        )}
      </ScrollView>
    </AuroraBackground>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  card: { gap: 10 },
  eyebrow: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold, letterSpacing: 0.6 },
  title: { color: TText.primary, fontSize: Font.callout, fontWeight: Font.semibold },
  desc: { color: TText.secondary, fontSize: Font.footnote, lineHeight: 19 },
  photoActions: { flexDirection: 'row', gap: 8 },
  secondaryButton: { borderWidth: 1, borderColor: Brand.redMid, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 9 },
  secondaryText: { color: Brand.red, fontSize: Font.footnote, fontWeight: Font.semibold },
  photoRow: { gap: 8, paddingVertical: 2 },
  photo: { width: 72, height: 72, borderRadius: Radius.md, backgroundColor: '#f2f2f2' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.14)', borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, color: TText.primary, fontSize: Font.body, backgroundColor: '#fff' },
  topicInput: { minHeight: 74, textAlignVertical: 'top' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: TText.primary, fontSize: Font.body, fontWeight: Font.semibold },
  status: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold },
  taskId: { color: TText.tertiary, fontSize: Font.caption },
  outlineButton: { minHeight: 42, borderWidth: 1, borderColor: Brand.redMid, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  outlineText: { color: Brand.red, fontSize: Font.footnote, fontWeight: Font.semibold },
  error: { color: '#b91c1c', fontSize: Font.caption },
  draftTitle: { color: TText.primary, fontSize: Font.body, fontWeight: Font.semibold },
  draftBody: { color: TText.secondary, fontSize: Font.footnote, lineHeight: 19 },
  tags: { color: Brand.red, fontSize: Font.caption },
  hint: { color: TText.tertiary, fontSize: Font.caption, lineHeight: 17 },
  receiptRow: { flexDirection: 'row', gap: 8 },
  receiptButton: { flex: 1, borderWidth: 1, borderColor: Brand.redMid, borderRadius: Radius.md, alignItems: 'center', paddingVertical: 10 },
  receiptText: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold },
  receiptPrimary: { backgroundColor: Brand.red, borderColor: Brand.red },
  receiptPrimaryText: { color: '#fff', fontSize: Font.caption, fontWeight: Font.semibold },
});
