import { useEffect, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { IS_TAURI_RUNTIME, readLocalImageData } from "../lib/local";
import { useAccountContext } from "../lib/accountContext";

const PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Crect width='160' height='160' fill='%23f4f4f5'/%3E%3Cpath d='M52 104l20-23 17 17 11-13 22 19H52z' fill='%23d4d4d8'/%3E%3Ccircle cx='72' cy='61' r='9' fill='%23d4d4d8'/%3E%3C/svg%3E";

const IMAGE_CACHE_VERSION = "v1";
const IMAGE_CACHE_LIMIT = 128;
const imageCache = new Map<string, string>();
const pendingImages = new Map<string, Promise<string | null>>();

function imageCacheKey(databaseIdentity: string, accountId: number, itemId: number, version = IMAGE_CACHE_VERSION, variant = "original") {
  return `${databaseIdentity}:account:${accountId}:item:${itemId}:variant:${variant}:version:${version}`;
}

function cacheImage(key: string, value: string) {
  // Map 的插入顺序提供一个轻量 LRU：重复命中时刷新位置，超限淘汰最旧项。
  imageCache.delete(key);
  imageCache.set(key, value);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
}

function loadLocalImage(databaseIdentity: string, accountId: number, itemId: number, version?: string, variant: "original" | "thumbnail" = "original") {
  const key = imageCacheKey(databaseIdentity, accountId, itemId, version, variant);
  const cached = imageCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingImages.get(key);
  if (pending) return pending;

  const request = readLocalImageData(itemId, accountId, variant)
    .then((value) => {
      if (value) cacheImage(key, value);
      return value;
    })
    .finally(() => pendingImages.delete(key));
  pendingImages.set(key, request);
  return request;
}

type LocalImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  itemId?: number;
  version?: string;
  variant?: "original" | "thumbnail";
};

/** 浏览器继续使用 HTTP 图片地址，Tauri 本地模式从 Rust 读取受账号隔离的图片。 */
export default function LocalImage({ itemId, version, variant = "original", src: remoteSrc, onError, ...props }: LocalImageProps) {
  const { accountId, databaseIdentity } = useAccountContext();
  const useLocalSource = IS_TAURI_RUNTIME && itemId !== undefined;
  const cacheKey = useLocalSource && accountId !== null
    ? imageCacheKey(databaseIdentity, accountId, itemId!, version, variant)
    : null;
  const [src, setSrc] = useState(() => {
    if (!useLocalSource) return remoteSrc;
    return (cacheKey && imageCache.get(cacheKey)) ?? PLACEHOLDER_SRC;
  });

  useEffect(() => {
    if (!useLocalSource) {
      setSrc(remoteSrc);
      return;
    }

    if (accountId === null) {
      setSrc(PLACEHOLDER_SRC);
      return;
    }
    let cancelled = false;
    setSrc((cacheKey && imageCache.get(cacheKey)) ?? PLACEHOLDER_SRC);
    loadLocalImage(databaseIdentity, accountId, itemId!, version, variant).then((value) => {
      if (!cancelled) setSrc(value ?? PLACEHOLDER_SRC);
    }).catch(() => {
      if (!cancelled) setSrc(PLACEHOLDER_SRC);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, cacheKey, databaseIdentity, itemId, remoteSrc, useLocalSource, variant, version]);

  return (
    <img
      {...props}
      src={src}
      onError={(event) => {
        setSrc(PLACEHOLDER_SRC);
        onError?.(event);
      }}
    />
  );
}
