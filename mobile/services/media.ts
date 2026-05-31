/**
 * media.ts — 基于 expo-media-library legacy API
 *
 * 使用旧版 API（getAssetsAsync / getPermissionsAsync / presentPermissionsPickerAsync）
 * Asset.uri 在 iOS 是 ph:// 格式，在展示时直接可用于 Image
 * PermissionResponse.accessPrivileges: 'all' | 'limited' | 'none'
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { Linking } from 'react-native';

export type MediaAsset = MediaLibrary.Asset;
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
 * 获取图片可展示的 localUri（file:// 格式）
 * ph:// 需经 getAssetInfoAsync 转换，file:// 直接返回
 */
export async function resolveLocalUri(uri: string): Promise<string> {
  if (!uri.startsWith('ph://')) return uri;
  // ph:// 格式：ph://<assetId>/...，取第一段作为 assetId
  const assetId = uri.replace('ph://', '').split('/')[0];
  const info = await MediaLibrary.getAssetInfoAsync(assetId);
  return info.localUri ?? uri;
}

/**
 * 获取图片 URI（legacy Asset.uri 在 iOS 是 ph://，Image 组件可直接用）
 * 也兼容直接传 uri 字符串的旧场景
 */
export function getImageUri(assetOrUri: MediaAsset | string): string {
  if (typeof assetOrUri === 'string') return assetOrUri;
  return assetOrUri.uri;
}

/**
 * 将多张图片导出到系统相册（按笔记标题建相册）
 * uris: ph:// 或 file:// 均可
 */
export async function exportToAlbum(uris: string[], albumName: string): Promise<void> {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') throw new Error('未获得相册写入权限');

  let album = await MediaLibrary.getAlbumAsync(albumName);
  for (const uri of uris) {
    const asset = await MediaLibrary.createAssetAsync(uri);
    if (!album) {
      album = await MediaLibrary.createAlbumAsync(albumName, asset, false);
    } else {
      await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    }
  }
}

/**
 * 读取图片 base64（用于 AI 分析）
 * iOS ph:// 需先用 getAssetInfoAsync 取 localUri
 */
export async function readBase64FromAsset(asset: MediaAsset): Promise<string> {
  const localUri = await resolveLocalUri(asset.uri);
  return FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * 从 URI 字符串（支持 ph://）直接读取 base64
 */
export async function readBase64FromUri(uri: string): Promise<string> {
  const localUri = await resolveLocalUri(uri);
  return FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
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
