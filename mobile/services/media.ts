/**
 * media.ts — 基于 expo-media-library legacy API
 *
 * 使用旧版 API（getAssetsAsync / getPermissionsAsync / presentPermissionsPickerAsync）
 * Asset.uri 在 iOS 是 ph:// 格式，需经 resolveLocalUri 转 file:// 后再给 RN Image / 读文件。
 * PermissionResponse.accessPrivileges: 'all' | 'limited' | 'none'
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Linking } from 'react-native';

export type MediaAsset = MediaLibrary.Asset;
export type ImageAssetReference = { uri: string; sourceAssetId: string | null };
export type PermissionInfo = {
  granted: boolean;
  limited: boolean; // true = 仅限所选照片
};

/**
 * 请求相册权限，返回权限状态
 */
export async function requestMediaPermission(): Promise<PermissionInfo> {
  const result = await MediaLibrary.requestPermissionsAsync();
  return {
    granted: result.granted,
    limited: result.accessPrivileges === 'limited',
  };
}

/**
 * 查询当前权限状态（不弹框）
 */
export async function getMediaPermission(): Promise<PermissionInfo> {
  const result = await MediaLibrary.getPermissionsAsync();
  return {
    granted: result.granted,
    limited: result.accessPrivileges === 'limited',
  };
}

/**
 * 呼出 iOS 系统「修改所选照片」选择器（仅限 iOS 14+ 真机）
 * 模拟器不支持，降级到系统设置
 */
export async function presentPermissionPicker(): Promise<void> {
  try {
    await MediaLibrary.presentPermissionsPickerAsync(['photo']);
  } catch {
    Linking.openSettings();
  }
}

/**
 * 跳转系统设置页（用户完全拒绝时引导手动开启）
 */
export function openAppSettings(): void {
  Linking.openSettings();
}

/**
 * 分页读取系统相册图片（按创建时间倒序）
 */
export async function fetchAssets(options?: {
  after?: string;
  first?: number;
}): Promise<{ assets: MediaAsset[]; endCursor: string; hasNextPage: boolean }> {
  const result = await MediaLibrary.getAssetsAsync({
    mediaType: MediaLibrary.MediaType.photo,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    first: options?.first ?? 60,
    after: options?.after,
  });
  return {
    assets: result.assets,
    endCursor: result.endCursor,
    hasNextPage: result.hasNextPage,
  };
}

/**
 * 将 iOS ph:// 转成 RN Image 可读的 file://；网格可传 shouldDownloadFromNetwork:false
 * 避免为了离屏缩略图等待 iCloud 原图。云端照片尚未下载时返回 ph://，由可视图片或实际使用流程按需读取。
 * 结果做进程内缓存；localIdentifier 形如 UUID/L0/001，不能截断。
 */
const localUriCache = new Map<string, string>();
const localUriPending = new Map<string, Promise<string>>();

export async function resolveLocalUri(
  uri: string,
  options: { shouldDownloadFromNetwork?: boolean } = {},
): Promise<string> {
  if (!uri.startsWith('ph://')) return uri;
  const cached = localUriCache.get(uri);
  if (cached) return cached;

  const shouldDownloadFromNetwork = options.shouldDownloadFromNetwork ?? true;
  const cacheKey = `${uri}:${shouldDownloadFromNetwork ? 'network' : 'local'}`;
  const inflight = localUriPending.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    const assetId = uri.slice('ph://'.length);
    const info = await MediaLibrary.getAssetInfoAsync(assetId, { shouldDownloadFromNetwork });
    const localUri = info?.localUri ?? uri;
    if (localUri.startsWith('file://')) localUriCache.set(uri, localUri);
    return localUri;
  })().finally(() => {
    localUriPending.delete(cacheKey);
  });

  localUriPending.set(cacheKey, task);
  return task;
}

/** Notify consumers when the system photo library changes. */
export function subscribeToMediaChanges(listener: () => void) {
  return MediaLibrary.addListener(listener);
}

/**
 * 获取图片 URI（相册 Asset.uri，iOS 为 ph://，需经 resolveLocalUri 后再给 Image）
 * 也兼容直接传 uri 字符串的旧场景
 */
export function getImageUri(assetOrUri: MediaAsset | string): string {
  if (typeof assetOrUri === 'string') return assetOrUri;
  return assetOrUri.uri;
}

/**
 * Resolve an image-picker asset back to the system photo library when it exposes
 * a library asset ID. The picker URI remains the fallback for camera/temp files.
 */
export async function getImageAssetReference(
  assetId: string | null | undefined,
  fallbackUri: string,
): Promise<ImageAssetReference> {
  if (!assetId) return { uri: fallbackUri, sourceAssetId: null };
  try {
    const asset = await MediaLibrary.getAssetInfoAsync(assetId, { shouldDownloadFromNetwork: false });
    return { uri: asset.uri || fallbackUri, sourceAssetId: asset.id || assetId };
  } catch {
    return { uri: fallbackUri, sourceAssetId: assetId };
  }
}

/**
 * 将多张图片导出到系统相册（按笔记标题建相册）
 * 策略：
 * 1. 申请「添加照片」权限（writeOnly）
 * 2. ph:// 已在系统相册 → 尝试挂到目标相册（失败则跳过，避免重复入库）
 * 3. 沙盒文件 → saveToLibraryAsync 优先，失败再 createAssetAsync
 * 4. 相册创建失败不算致命，只要进了系统相册就算成功（返回已保存数量）
 */
export async function exportToAlbum(uris: string[], albumName: string): Promise<void> {
  const writePerm = await MediaLibrary.requestPermissionsAsync(true).catch(() => null);
  const readPerm = await MediaLibrary.getPermissionsAsync().catch(() => null);
  const canWrite =
    !!writePerm?.granted || writePerm?.status === 'granted' || !!readPerm?.granted;
  if (!canWrite) {
    throw new Error('需要相册写入权限：请到 设置 → 爱吃红薯 → 照片，允许「添加照片」或「完全访问」');
  }

  let album: MediaLibrary.Album | null = null;
  try {
    album = await MediaLibrary.getAlbumAsync(albumName);
  } catch {
    album = null;
  }

  let saved = 0;
  const errors: string[] = [];

  for (const uri of uris) {
    try {
      // 已在系统相册的图：优先挂到目标相册
      if (uri.startsWith('ph://')) {
        const assetId = uri.slice('ph://'.length);
        const info = await MediaLibrary.getAssetInfoAsync(assetId).catch(() => null);
        if (info) {
          const asset = info as unknown as MediaLibrary.Asset;
          if (!album) {
            album = await MediaLibrary.createAlbumAsync(albumName, asset, true);
          } else {
            await MediaLibrary.addAssetsToAlbumAsync([asset], album, true);
          }
          saved += 1;
          continue;
        }
      }

      const local = await resolveLocalUri(uri);
      // 先用 saveToLibraryAsync（add-only 权限也常能成功）
      try {
        await MediaLibrary.saveToLibraryAsync(local);
        saved += 1;
      } catch {
        const asset = await MediaLibrary.createAssetAsync(local);
        if (!album) {
          album = await MediaLibrary.createAlbumAsync(albumName, asset, true);
        } else {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, true);
        }
        saved += 1;
      }
    } catch (e: any) {
      errors.push(String(e?.message ?? e));
    }
  }

  if (saved === 0) {
    throw new Error(errors[0] ? `导出失败：${errors[0]}` : '导出失败：没有图片写入相册');
  }
}

/**
 * 读取图片 base64（用于 AI 分析）
 * iOS ph:// 需先用 getAssetInfoAsync 取 localUri；优先用 asset.id（完整 localIdentifier）。
 * 若原图是 HEIC 等模型不识别的格式，先转成 JPEG，避免服务端 decode 失败。
 */
export async function readBase64FromAsset(asset: MediaAsset): Promise<string> {
  const localUri = asset.uri.startsWith('ph://')
    ? await resolveLocalUri(asset.uri)
    : asset.uri;
  return readBase64FromUri(localUri);
}

/**
 * 从 URI 字符串（支持 ph://）读取可供 AI 识别的图片 base64。
 * HEIC/未知格式会转成 JPEG（长边 ≤1600），JPEG/PNG/GIF/WebP 原样返回。
 */
export async function readBase64FromUri(uri: string): Promise<string> {
  const localUri = await resolveLocalUri(uri);
  if (localUri.startsWith('ph://')) {
    throw new Error('无法读取相册原图文件，请检查照片权限后重试');
  }
  const b64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const mime = sniffImageMimeFromBase64(b64);
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp') {
    return b64;
  }
  // HEIC / HEIF / 未知容器 → 转 JPEG
  const converted = await ImageManipulator.manipulateAsync(
    localUri,
    [{ resize: { width: 1600 } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );
  if (!converted.base64) throw new Error('图片转换为 JPEG 失败');
  return converted.base64;
}

/** 识别 base64 图片真实 MIME（用于标注 media_type / 判断是否需转码） */
export function sniffImageMimeFromBase64(b64: string): string | null {
  const head = decodeBase64Prefix(b64, 16);
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'image/gif';
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) return 'image/webp';
  // ISO BMFF（HEIC/HEIF）：offset 4 为 'ftyp'
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    return 'image/heic';
  }
  return null;
}

function decodeBase64Prefix(b64: string, maxBytes: number): number[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 3 < clean.length && bytes.length < maxBytes; i += 4) {
    const c0 = alphabet.indexOf(clean[i]);
    const c1 = alphabet.indexOf(clean[i + 1]);
    const c2 = alphabet.indexOf(clean[i + 2]);
    const c3 = alphabet.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) break;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (bytes.length >= maxBytes) break;
    bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (bytes.length >= maxBytes) break;
    bytes.push(((c2 & 3) << 6) | c3);
  }
  return bytes;
}

/**
 * 拍照，返回保存后的 asset（uri）和 base64
 */
export async function takePhoto(): Promise<{ asset: MediaAsset; base64: string } | null> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') throw new Error('未获得相机权限');

  const result = await ImagePicker.launchCameraAsync({ quality: 0.8, base64: true });
  if (result.canceled || !result.assets[0]) return null;

  const pickerAsset = result.assets[0];
  const savedAsset = await MediaLibrary.createAssetAsync(pickerAsset.uri);
  return { asset: savedAsset, base64: pickerAsset.base64 ?? '' };
}
