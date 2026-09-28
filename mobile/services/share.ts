import { Share as RNShare, TurboModuleRegistry, NativeModules } from 'react-native';
import { resolveLocalUri, exportToAlbum } from './media';

export type ShareOutcome = 'shared' | 'dismissed';

/**
 * react-native-share（支持一次带多图）在 Expo Go 里没有原生模块，
 * require 期 TurboModule getEnforcing 会直接抛；先探测再加载。
 */
function hasNativeMultiShare(): boolean {
  try {
    return !!(TurboModuleRegistry.get?.('RNShare') || (NativeModules as any)?.RNShare);
  } catch {
    return false;
  }
}

function loadNativeShare(): any | null {
  if (!hasNativeMultiShare()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-share').default ?? require('react-native-share');
  } catch {
    return null;
  }
}

async function toFileUrls(uris: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const uri of uris) {
    const local = await resolveLocalUri(uri);
    urls.push(local.startsWith('file://') ? local : `file://${local}`);
  }
  return urls;
}

/**
 * 唤起系统分享面板，尽量一次带出全部图片 + 文案。
 * - 有 react-native-share 原生模块（dev build）：多图一次带出
 * - Expo Go / 无原生模块：自动把图导出到相册（可多选），分享面板带文案+首图作预览
 */
export async function shareImagesWithText(
  uris: string[],
  options: { message?: string; title?: string; albumName?: string } = {},
): Promise<ShareOutcome> {
  const urls = await toFileUrls(uris);
  if (urls.length === 0) throw new Error('没有可分享的图片');

  const message = options.message ?? '';
  const title = options.title;

  // ── 主路径：react-native-share 多图 ──
  const NativeShare = loadNativeShare();
  if (NativeShare?.open) {
    try {
      const res = await NativeShare.open({
        urls,
        ...(message ? { message } : {}),
        ...(title ? { title } : {}),
        failOnCancel: false,
      } as any);
      if (res?.success === false) return 'dismissed';
      return 'shared';
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/user did not share|cancelled|canceled|dismiss/i.test(msg)) return 'dismissed';
      // 继续走 RN Share 兜底
    }
  }

  // ── 兜底：RN Share（只能带 1 张）+ 多图进相册 ──
  if (urls.length > 1 && options.albumName) {
    try {
      await exportToAlbum(uris, options.albumName);
    } catch {
      // 导出失败不阻断分享
    }
  }

  const payload: { message?: string; url?: string; title?: string } = {};
  if (message) {
    payload.message =
      urls.length > 1 && options.albumName
        ? `${message}\n\n（共 ${urls.length} 张图已保存到相册「${options.albumName}」，在小红书选图时选该相册）`
        : message;
  } else if (urls.length > 1) {
    payload.message = `分享 ${urls.length} 张图`;
  }
  payload.url = urls[0];
  if (title) payload.title = title;

  try {
    const res = await RNShare.share(payload as any);
    return res.action === RNShare.dismissedAction ? 'dismissed' : 'shared';
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/user did not share|cancelled|canceled|dismiss/i.test(msg)) return 'dismissed';
    throw e;
  }
}

/** 当前是否支持一次分享多张图（react-native-share 可用时为 true） */
export function supportsMultiImageShare(): boolean {
  return hasNativeMultiShare() && !!loadNativeShare()?.open;
}
