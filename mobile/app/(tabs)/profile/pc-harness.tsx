import {
  View, Text, ScrollView, TextInput, Pressable, Modal,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { AuroraBackground, LiquidButton, LiquidCard, GlassBackBar } from '../../../components/ui';
import { Brand, Text as TText, Font, Radius } from '../../../utils/theme';
import {
  clearPcHarnessConfig,
  createPcHarnessClientFromConfig,
  getPcHarnessConfig,
  parsePcHarnessPairingCode,
  savePcHarnessConfig,
  type PcHarnessConfig,
} from '../../../services/pcHarness';

const EMPTY_CONFIG: PcHarnessConfig = {
  baseUrl: '',
  pairingToken: '',
  deviceName: '我的手机',
};

export default function PcHarnessScreen() {
  const router = useRouter();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [config, setConfig] = useState<PcHarnessConfig>(EMPTY_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<'unknown' | 'connected' | 'failed'>('unknown');
  const [connectionMessage, setConnectionMessage] = useState('尚未检测');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const scanClaimed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getPcHarnessConfig().then((value) => {
      if (cancelled) return;
      if (value) {
        setConfig(value);
        setSaved(true);
      }
      setConfigLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setBusy(true);
    try {
      const next = await savePcHarnessConfig(config);
      setConfig(next);
      setSaved(true);
      setConnection('unknown');
      setConnectionMessage('已保存，等待连接检测');
      Alert.alert('已保存', 'PC Harness 配置已加密保存到本机。');
    } catch (error) {
      Alert.alert('保存失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    if (!saved) {
      Alert.alert('请先保存配置', '地址和配对令牌保存成功后才能测试连接。');
      return;
    }
    setBusy(true);
    setConnectionMessage('正在连接 PC Harness…');
    try {
      const client = createPcHarnessClientFromConfig(config);
      const health = await client.health();
      if (!health.ok || health.service !== 'pc-harness' || health.protocolVersion !== '1') {
        throw new Error('PC Harness 协议校验失败，请确认电脑端已更新并开启服务');
      }
      setConnection('connected');
      const message = `已连接 · 协议 ${health.protocolVersion}`;
      setConnectionMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnection('failed');
      setConnectionMessage(message);
    } finally {
      setBusy(false);
    }
  }

  async function openScanner() {
    try {
      if (!cameraPermission?.granted) {
        const permission = await requestCameraPermission();
        if (!permission.granted) {
          Alert.alert('需要相机权限', '允许爱吃红薯使用相机，才能扫描 PC Harness 配对二维码。');
          return;
        }
      }
      scanClaimed.current = false;
      setScanError('');
      setScannerVisible(true);
    } catch (error) {
      Alert.alert('无法打开相机', error instanceof Error ? error.message : String(error));
    }
  }

  async function handlePairingCode(raw: string) {
    if (scanClaimed.current) return;
    scanClaimed.current = true;
    setScanBusy(true);
    setScanError('');
    try {
      const scanned = parsePcHarnessPairingCode(raw);
      const health = await createPcHarnessClientFromConfig(scanned).health();
      if (!health.ok || health.service !== 'pc-harness' || health.protocolVersion !== '1') {
        throw new Error('PC Harness 协议校验失败，请确认 PC 端已更新并开启服务');
      }

      const next = await savePcHarnessConfig({
        ...config,
        ...scanned,
        deviceName: config.deviceName || EMPTY_CONFIG.deviceName,
      });
      setConfig(next);
      setSaved(true);
      setConnection('connected');
      const message = `已连接 · 协议 ${health.protocolVersion}`;
      setConnectionMessage(message);
      setScannerVisible(false);
    } catch (error) {
      scanClaimed.current = false;
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setScanBusy(false);
    }
  }

  function closeScanner() {
    if (scanBusy) return;
    scanClaimed.current = false;
    setScannerVisible(false);
    setScanError('');
  }

  function handleClear() {
    Alert.alert('解除 PC Harness', '将清除手机端保存的地址和配对令牌。', [
      { text: '取消', style: 'cancel' },
      { text: '解除', style: 'destructive', onPress: async () => {
        await clearPcHarnessConfig();
        setConfig(EMPTY_CONFIG);
        setSaved(false);
        setConnection('unknown');
        setConnectionMessage('尚未检测');
      } },
    ]);
  }

  const statusColor = connection === 'connected' ? '#15803d' : connection === 'failed' ? '#b91c1c' : TText.secondary;
  const statusLabel = !configLoaded
    ? '正在读取连接配置…'
    : !saved
      ? (config.baseUrl || config.pairingToken ? '配置未保存' : '尚未配对')
      : connection === 'connected'
        ? connectionMessage
        : connection === 'failed'
          ? `连接失败 · ${connectionMessage}`
          : '已保存配对信息，尚未检测连接';

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <LiquidCard style={styles.introCard}>
          <Text style={styles.eyebrow}>手机连接</Text>
          <Text style={styles.title}>连接电脑工作台</Text>
          <Text style={styles.desc}>手机与电脑接入同一 Wi-Fi 后，扫描电脑端二维码即可配对。连接后可在两端接续处理素材、文案与记忆。</Text>
        </LiquidCard>

        <View style={styles.statusCard}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <View style={styles.statusCopy}>
            <Text style={styles.statusTitle}>连接状态</Text>
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          {saved && connection !== 'connected' ? (
            <Pressable onPress={() => void handleTest()} disabled={busy} style={styles.statusAction}>
              {busy ? <ActivityIndicator size="small" color={Brand.red} /> : <Text style={styles.statusActionText}>测试</Text>}
            </Pressable>
          ) : null}
        </View>

        <LiquidButton
          label={saved ? '重新扫码配对' : '扫描电脑端二维码'}
          onPress={() => void openScanner()}
          disabled={busy || !configLoaded}
          style={{ alignSelf: 'stretch' }}
        />
        <Text style={styles.qrHint}>推荐方式 · 在电脑端打开 PC Harness 配对码</Text>

        <Pressable onPress={() => setManualOpen((open) => !open)} style={styles.manualDisclosure}>
          <Text style={styles.manualDisclosureText}>{manualOpen ? '收起手动配置' : '手动配置地址和令牌（高级）'}</Text>
          <Text style={styles.disclosureChevron}>{manualOpen ? '⌃' : '⌄'}</Text>
        </Pressable>

        {manualOpen ? (
          <>
            <LiquidCard style={styles.card}>
              <Text style={styles.hint}>扫码不可用时再手动填写。配对令牌会安全保存在手机。</Text>
              <Text style={styles.label}>电脑地址</Text>
              <TextInput
                value={config.baseUrl}
                onChangeText={(baseUrl) => { setConfig((current) => ({ ...current, baseUrl })); setSaved(false); setConnection('unknown'); setConnectionMessage('配置已修改，请保存并测试'); }}
                placeholder="http://电脑局域网地址:18765"
                placeholderTextColor={TText.tertiary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
              />

              <Text style={styles.label}>配对令牌</Text>
              <TextInput
                value={config.pairingToken}
                onChangeText={(pairingToken) => { setConfig((current) => ({ ...current, pairingToken })); setSaved(false); setConnection('unknown'); setConnectionMessage('配置已修改，请保存并测试'); }}
                placeholder="从电脑端复制配对令牌"
                placeholderTextColor={TText.tertiary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={styles.input}
              />

              <Text style={styles.label}>手机名称（可选）</Text>
              <TextInput
                value={config.deviceName ?? ''}
                onChangeText={(deviceName) => { setConfig((current) => ({ ...current, deviceName })); setSaved(false); }}
                placeholder="我的手机"
                placeholderTextColor={TText.tertiary}
                style={styles.input}
              />
            </LiquidCard>

            <LiquidButton label={busy ? '处理中…' : '保存手动配置'} onPress={handleSave} disabled={busy} />
            <LiquidButton
              label={busy ? '测试中…' : saved ? '测试连接' : '保存后可测试连接'}
              variant="glass"
              onPress={() => void handleTest()}
              disabled={busy || !saved}
              style={{ alignSelf: 'stretch' }}
            />
          </>
        ) : null}

        <Text style={styles.capabilityHint}>配对后可用手机上传素材、接收电脑生成稿，并回填发布结果。实时修改手机记忆需要手机 App 保持前台。</Text>

        {saved ? (
          <Pressable onPress={handleClear} style={styles.clearButton}>
            <Text style={styles.clearText}>解除配对并清除本机配置</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={closeScanner}
        statusBarTranslucent
      >
        <View style={styles.scannerRoot}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanBusy ? undefined : ({ data }) => void handlePairingCode(data)}
          />
          <View style={styles.scannerTop}>
            <Pressable onPress={closeScanner} disabled={scanBusy} style={styles.scannerClose}>
              <Text style={styles.scannerCloseText}>关闭</Text>
            </Pressable>
            <Text style={styles.scannerTitle}>扫描 PC 配对码</Text>
            <Text style={styles.scannerHint}>仅接受本项目生成的局域网 Harness 配对二维码</Text>
          </View>
          <View pointerEvents="none" style={styles.scannerFrame} />
          <View style={styles.scannerBottom}>
            {scanBusy ? (
              <View style={styles.scannerProgress}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.scannerBottomText}>正在验证并保存配对…</Text>
              </View>
            ) : scanError ? (
              <Text style={styles.scannerError}>{scanError}</Text>
            ) : (
              <Text style={styles.scannerBottomText}>把 PC 设置页的二维码放入框内</Text>
            )}
          </View>
        </View>
      </Modal>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12, paddingTop: 8 },
  introCard: { gap: 6 },
  eyebrow: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold, letterSpacing: 0.6 },
  title: { color: TText.primary, fontSize: Font.callout, fontWeight: Font.semibold },
  desc: { color: TText.secondary, fontSize: Font.footnote, lineHeight: 19 },
  card: { gap: 12 },
  label: { color: TText.secondary, fontSize: Font.caption, marginBottom: 8, marginTop: 4 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.14)', borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, color: TText.primary, fontSize: Font.body, backgroundColor: '#fff' },
  hint: { color: TText.tertiary, fontSize: Font.caption, lineHeight: 17 },
  statusCard: { borderRadius: Radius.md, backgroundColor: '#fff', padding: 12, gap: 10, flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 9, height: 9, borderRadius: 99 },
  statusCopy: { flex: 1, gap: 4 },
  statusTitle: { color: TText.secondary, fontSize: Font.caption, fontWeight: Font.semibold },
  statusText: { fontSize: Font.footnote },
  statusAction: { minHeight: 34, minWidth: 46, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff5f6' },
  statusActionText: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold },
  qrHint: { textAlign: 'center', color: TText.tertiary, fontSize: Font.caption, marginTop: -6 },
  manualDisclosure: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  manualDisclosureText: { color: TText.secondary, fontSize: Font.footnote },
  disclosureChevron: { color: TText.secondary, fontSize: Font.title3 },
  capabilityHint: { color: TText.tertiary, fontSize: Font.caption, lineHeight: 17, paddingHorizontal: 4 },
  clearButton: { alignItems: 'center', paddingVertical: 12 },
  clearText: { color: '#b91c1c', fontSize: Font.caption },
  scannerRoot: { flex: 1, backgroundColor: '#000' },
  scannerTop: { position: 'absolute', top: 56, left: 24, right: 24, alignItems: 'center', gap: 8 },
  scannerClose: { position: 'absolute', left: 0, top: 0, paddingHorizontal: 12, paddingVertical: 8, borderRadius: Radius.md, backgroundColor: 'rgba(0,0,0,0.48)' },
  scannerCloseText: { color: '#fff', fontSize: Font.footnote, fontWeight: Font.semibold },
  scannerTitle: { color: '#fff', fontSize: Font.title3, fontWeight: Font.semibold, marginTop: 40 },
  scannerHint: { color: 'rgba(255,255,255,0.76)', fontSize: Font.caption, textAlign: 'center' },
  scannerFrame: { position: 'absolute', top: '34%', alignSelf: 'center', width: 252, height: 252, borderWidth: 2, borderColor: '#fff', borderRadius: 24 },
  scannerBottom: { position: 'absolute', bottom: 56, left: 24, right: 24, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  scannerProgress: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  scannerBottomText: { color: '#fff', fontSize: Font.footnote, textAlign: 'center' },
  scannerError: { color: '#fff', backgroundColor: 'rgba(153,27,27,0.86)', borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: Font.caption, textAlign: 'center' },
});
