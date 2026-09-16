import { useEffect, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { IS_TAURI_RUNTIME, readLocalImageData } from "../lib/local";

const PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Crect width='160' height='160' fill='%23f4f4f5'/%3E%3Cpath d='M52 104l20-23 17 17 11-13 22 19H52z' fill='%23d4d4d8'/%3E%3Ccircle cx='72' cy='61' r='9' fill='%23d4d4d8'/%3E%3C/svg%3E";

const imageCache = new Map<number, string>();
const pendingImages = new Map<number, Promise<string | null>>();

function loadLocalImage(itemId: number) {
  const cached = imageCache.get(itemId);
  if (cached) return Promise.resolve(cached);

  const pending = pendingImages.get(itemId);
  if (pending) return pending;

  const request = readLocalImageData(itemId)
    .then((value) => {
      if (value) imageCache.set(itemId, value);
      return value;
    })
    .finally(() => pendingImages.delete(itemId));
  pendingImages.set(itemId, request);
  return request;
}

type LocalImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  itemId?: number;
};

/** 浏览器继续使用 HTTP 图片地址，Tauri 本地模式从 Rust 读取受账号隔离的图片。 */
export default function LocalImage({ itemId, src: remoteSrc, onError, ...props }: LocalImageProps) {
  const useLocalSource = IS_TAURI_RUNTIME && itemId !== undefined;
  const [src, setSrc] = useState(() => {
    if (!useLocalSource) return remoteSrc;
    return imageCache.get(itemId!) ?? PLACEHOLDER_SRC;
  });

  useEffect(() => {
    if (!useLocalSource) {
      setSrc(remoteSrc);
      return;
    }

    let cancelled = false;
    setSrc(imageCache.get(itemId!) ?? PLACEHOLDER_SRC);
    loadLocalImage(itemId!).then((value) => {
      if (!cancelled) setSrc(value ?? PLACEHOLDER_SRC);
    }).catch(() => {
      if (!cancelled) setSrc(PLACEHOLDER_SRC);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, remoteSrc, useLocalSource]);

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
