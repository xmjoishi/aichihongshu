/**
 * HDR 图片显示控制
 *
 * 在支持 HDR 的显示器上，直接渲染 HDR 图片会颜色过曝。
 * 此 hook 提供一个全局开关（存 localStorage，默认关闭），
 * 关闭时在 <body> 上挂载 data-hdr="off" attribute，
 * 配合全局 CSS 对所有图片应用 filter。
 */
import { useState, useEffect, useCallback } from "react";

const LS_KEY = "hdr_display";

function readLS(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "true";
  } catch {
    return false;
  }
}

function applyToDOM(hdr: boolean) {
  document.documentElement.setAttribute("data-hdr", hdr ? "on" : "off");
}

export function useHDRSetting() {
  const [hdr, setHdr] = useState<boolean>(readLS);

  useEffect(() => {
    const val = readLS();
    setHdr(val);
    applyToDOM(val);

    function onHDRChange(e: Event) {
      const v = (e as CustomEvent<boolean>).detail;
      setHdr(v);
      applyToDOM(v);
    }
    window.addEventListener("hdr-setting-change", onHDRChange);
    return () => window.removeEventListener("hdr-setting-change", onHDRChange);
  }, []);

  const toggle = useCallback((value: boolean) => {
    try {
      localStorage.setItem(LS_KEY, String(value));
    } catch { /* ignore */ }
    setHdr(value);
    applyToDOM(value);
    window.dispatchEvent(new CustomEvent("hdr-setting-change", { detail: value }));
  }, []);

  /**
   * 兼容旧用法：返回空对象（filter 现在由全局 CSS 统一处理）
   * 保留此函数签名避免修改所有调用处
   */
  const imgStyle = (): React.CSSProperties => ({});

  return { hdr, toggle, imgStyle };
}
