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
      setConnection('connected');
      const message = `已连接 · 协议 ${health.protocolVersion}`;
      setConnectionMessage(message);
      Alert.alert('连接成功', message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnection('failed');
      setConnectionMessage(message);
      Alert.alert('连接失败', message);
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
      Alert.alert('配对成功', `${scanned.baseUrl}\n配对信息已安全保存在手机。`);
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

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <LiquidCard style={styles.introCard}>
          <Text style={styles.eyebrow}>手机 Companion</Text>
          <Text style={styles.title}>连接同一 Wi-Fi 下的 PC 工作台</Text>
          <Text style={styles.desc}>手机负责拍照、输入和发布回填，PC Harness 负责账号作用域、素材和笔记任务。手机记忆以手机为事实源；PC 在线修改由手机保存后回传缓存。手机 App 前台连接时才能实时维护。地址与配对令牌只保存在手机安全存储中。</Text>
        </LiquidCard>

        <LiquidButton
          label="扫码快速配对 PC Harness"
          onPress={() => void openScanner()}
          disabled={busy || !configLoaded}
          style={{ alignSelf: 'stretch' }}
        />

        <Text style={styles.groupLabel}>连接配置</Text>
        <LiquidCard style={styles.card}>
          <Text style={styles.label}>PC Harness 地址</Text>
          <TextInput
            value={config.baseUrl}
            onChangeText={(baseUrl) => { setConfig((current) => ({ ...current, baseUrl })); setSaved(false); }}
            placeholder="http://100.73.191.113:18765"
            placeholderTextColor={TText.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
          <Text style={styles.hint}>也可扫描 PC 设置页显示的二维码；扫描后会先验证连接，再安全保存配置。</Text>

          <Text style={styles.label}>配对令牌</Text>
          <TextInput
            value={config.pairingToken}
            onChangeText={(pairingToken) => { setConfig((current) => ({ ...current, pairingToken })); setSaved(false); }}
            placeholder="从 PC Harness 配对页面复制"
            placeholderTextColor={TText.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />

          <Text style={styles.label}>手机名称（可选）</Text>
          <TextInput
            value={config.deviceName ?? ''}
            onChangeText={(deviceName) => setConfig((current) => ({ ...current, deviceName }))}
            placeholder="我的手机"
            placeholderTextColor={TText.tertiary}
            style={styles.input}
          />
        </LiquidCard>

        <LiquidButton label={busy ? '处理中…' : '保存配置'} onPress={handleSave} disabled={busy} />
        <LiquidButton
          label={busy ? '测试中…' : saved ? '测试 PC Harness 连接' : '请先保存配置'}
          variant="glass"
          onPress={() => void handleTest()}
          disabled={busy || !saved}
          style={{ alignSelf: 'stretch' }}
        />

        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>连接状态</Text>
          <Text style={[styles.statusText, { color: statusColor }]}>{connectionMessage}</Text>
        </View>

        <Text style={styles.groupLabel}>当前契约能力</Text>
        <LiquidCard style={styles.card}>
          <Capability label="拍照 / 文字上传到 PC" />
          <Capability label="从 PC 拉取生成稿" />
          <Capability label="发布后回填链接和结果" />
          <Text style={styles.hint}>这些操作会在“创作 → PC Companion”中使用同一配对连接；桌面端需先开启手机连接。</Text>
        </LiquidCard>

        <Pressable onPress={handleClear} style={styles.clearButton}>
          <Text style={styles.clearText}>解除配对并清除本机配置</Text>
        </Pressable>
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

function Capability({ label }: { label: string }) {
  return (
    <View style={styles.capabilityRow}>
      <Text style={styles.capabilityIcon}>✓</Text>
      <Text style={styles.capabilityText}>{label}</Text>
      <Text style={styles.pending}>可用</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12, paddingTop: 8 },
  introCard: { gap: 6 },
  eyebrow: { color: Brand.red, fontSize: Font.caption, fontWeight: Font.semibold, letterSpacing: 0.6 },
  title: { color: TText.primary, fontSize: Font.callout, fontWeight: Font.semibold },
  desc: { color: TText.secondary, fontSize: Font.footnote, lineHeight: 19 },
  groupLabel: { color: TText.secondary, fontSize: Font.caption, fontWeight: Font.semibold, marginTop: 8 },
  card: { gap: 12 },
  label: { color: TText.secondary, fontSize: Font.caption, marginBottom: 8, marginTop: 4 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.14)', borderRadius: Radius.md, paddingHorizontal: 12, paddingVertical: 10, color: TText.primary, fontSize: Font.body, backgroundColor: '#fff' },
  hint: { color: TText.tertiary, fontSize: Font.caption, lineHeight: 17 },
  testButton: { minHeight: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Brand.redMid, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  testButtonText: { color: Brand.red, fontSize: Font.body, fontWeight: Font.semibold },
  statusCard: { borderRadius: Radius.md, backgroundColor: '#fff', padding: 14, gap: 5 },
  statusTitle: { color: TText.secondary, fontSize: Font.caption, fontWeight: Font.semibold },
  statusText: { fontSize: Font.footnote },
  capabilityRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  capabilityIcon: { color: Brand.red, fontWeight: Font.bold, fontSize: Font.body },
  capabilityText: { flex: 1, color: TText.primary, fontSize: Font.footnote },
  pending: { color: TText.tertiary, fontSize: Font.caption },
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
