import { memo, useEffect, useRef, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { IS_TAURI_RUNTIME, readLocalImageData } from "../lib/local";
import { useWorkspaceActive } from "../lib/workspaceActivity";
import { useAccountContext } from "../lib/accountContext";

const PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Crect width='160' height='160' fill='%23f4f4f5'/%3E%3Cpath d='M52 104l20-23 17 17 11-13 22 19H52z' fill='%23d4d4d8'/%3E%3Ccircle cx='72' cy='61' r='9' fill='%23d4d4d8'/%3E%3C/svg%3E";

const IMAGE_CACHE_VERSION = "v1";
const IMAGE_CACHE_LIMIT = 128;
const IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
let cachedBytes = 0;
const imageCache = new Map<string, string>();
// Bound IPC/file reads even when many cards enter the viewport together.
const imageReadQueue: Array<() => Promise<void>> = [];
let activeReads = 0;
function drainImageReads() {
  while (activeReads < 4 && imageReadQueue.length) {
    const job = imageReadQueue.shift()!;
    activeReads += 1;
    void job().finally(() => { activeReads -= 1; drainImageReads(); });
  }
}

const visibilityCallbacks = new Map<Element, (visible: boolean) => void>();
let imageObserver: IntersectionObserver | null = null;
function observeImage(element: Element, callback: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") { callback(true); return () => {}; }
  imageObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visibilityCallbacks.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: "240px" });
  visibilityCallbacks.set(element, callback);
  imageObserver.observe(element);
  return () => { imageObserver?.unobserve(element); visibilityCallbacks.delete(element); };
}

const pendingImages = new Map<string, Promise<string | null>>();

function imageCacheKey(databaseIdentity: string, accountId: number, itemId: number, version = IMAGE_CACHE_VERSION, variant = "original") {
  return `${databaseIdentity}:account:${accountId}:item:${itemId}:variant:${variant}:version:${version}`;
}

function cacheImage(key: string, value: string) {
  // Map 的插入顺序提供一个轻量 LRU：重复命中时刷新位置，超限淘汰最旧项。
  cachedBytes -= (imageCache.get(key)?.length ?? 0) * 2;
  imageCache.delete(key);
  imageCache.set(key, value);
  cachedBytes += value.length * 2;
  while (imageCache.size > IMAGE_CACHE_LIMIT || cachedBytes > IMAGE_CACHE_BYTES) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    cachedBytes -= (imageCache.get(oldest)?.length ?? 0) * 2;
    imageCache.delete(oldest);
  }
}

function loadLocalImage(databaseIdentity: string, accountId: number, itemId: number, version?: string, variant: "original" | "thumbnail" = "original") {
  const key = imageCacheKey(databaseIdentity, accountId, itemId, version, variant);
  const cached = imageCache.get(key);
  if (cached) { cacheImage(key, cached); return Promise.resolve(cached); }

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
function LocalImage({ itemId, version, variant = "original", src: remoteSrc, onError, ...props }: LocalImageProps) {
  const active = useWorkspaceActive();
  const imageRef = useRef<HTMLImageElement>(null);
  const { accountId, databaseIdentity } = useAccountContext();
  const useLocalSource = IS_TAURI_RUNTIME && itemId !== undefined;
  const cacheKey = useLocalSource && accountId !== null
    ? imageCacheKey(databaseIdentity, accountId, itemId!, version, variant)
    : null;
  const sourceKey = cacheKey ?? remoteSrc;
  const sourceKeyRef = useRef(sourceKey);
  const [dimensions, setDimensions] = useState<{ key: string; ratio: number } | null>(null);
  const [src, setSrc] = useState(() => {
    if (!useLocalSource) return remoteSrc;
    return (cacheKey && imageCache.get(cacheKey)) ?? PLACEHOLDER_SRC;
  });

  useEffect(() => {
    sourceKeyRef.current = sourceKey;
    setSrc(useLocalSource ? PLACEHOLDER_SRC : remoteSrc);
    if (!useLocalSource) {
      setSrc(remoteSrc);
      return;
    }

    if (accountId === null) {
      setSrc(PLACEHOLDER_SRC);
      return;
    }
    let cancelled = false;
    let visible = props.loading === "eager";
    let queued = false;
    let loaded = false;
    if (!active) { setSrc(PLACEHOLDER_SRC); return; }
    const request = () => {
      if (cancelled || !visible || queued || loaded) return;
      queued = true;
      imageReadQueue.push(async () => {
        if (cancelled || !visible) { queued = false; return; }
        try {
          const value = await loadLocalImage(databaseIdentity, accountId, itemId!, version, variant);
          loaded = true;
          if (!cancelled && visible) setSrc(value ?? PLACEHOLDER_SRC);
          if (!visible) loaded = false;
        } catch {
          loaded = true;
          if (!cancelled) setSrc(PLACEHOLDER_SRC);
        } finally { queued = false; }
      });
      drainImageReads();
    };
    const unobserve = visible ? (request(), () => {}) : imageRef.current
      ? observeImage(imageRef.current, (inView) => {
          visible = inView;
          if (!inView) { loaded = false; setSrc(PLACEHOLDER_SRC); }
          else request();
        })
      : () => {};
    return () => { cancelled = true; unobserve(); };
  }, [active, accountId, cacheKey, databaseIdentity, itemId, remoteSrc, useLocalSource, variant, version, props.loading, sourceKey]);

  return (
    <img
      {...props}
      ref={imageRef}
      decoding={props.decoding ?? "async"}
      style={{ ...(dimensions?.key === sourceKey ? { aspectRatio: dimensions.ratio } : {}), ...props.style }}
      onLoad={(event) => {
        const element = event.currentTarget;
        if (src !== PLACEHOLDER_SRC && element.naturalHeight > 0) {
          const ratio = element.naturalWidth / element.naturalHeight;
          setDimensions((old) => old?.key === sourceKey && old.ratio === ratio ? old : { key: sourceKey, ratio });
        }
        props.onLoad?.(event);
      }}
      src={sourceKeyRef.current === sourceKey ? src : PLACEHOLDER_SRC}
      onError={(event) => {
        setSrc(PLACEHOLDER_SRC);
        onError?.(event);
      }}
    />
  );
}

export default memo(LocalImage);
