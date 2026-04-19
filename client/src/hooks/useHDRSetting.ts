/**
 * HDR 图片显示控制
 *
 * 开关语义：
 *  hdr=true  → 「开启 HDR」→ 原图渲染，无 filter（HDR 显示器上色彩鲜艳/过曝）
 *  hdr=false → 「关闭 HDR」→ 加 filter 压制，模拟 SDR 效果（默认值）
 */
import { useState, useEffect, useCallback } from "react";

const LS_KEY = "hdr_display";

function readLS(): boolean {
  try {
    const v = localStorage.getItem(LS_KEY);
    // 只有明确存了 "true" 才算开启；null/其他值都是关闭
    return v === "true";
  } catch {
    return false;
  }
}

function applyToDOM(hdr: boolean) {
  document.documentElement.setAttribute("data-hdr", hdr ? "on" : "off");
}

// 模块级单例：避免多个组件各自监听时状态不同步
let _listeners: Array<(v: boolean) => void> = [];
let _current: boolean = readLS();

function notifyAll(v: boolean) {
  _current = v;
  _listeners.forEach((fn) => fn(v));
}

export function useHDRSetting() {
  const [hdr, setHdr] = useState<boolean>(() => {
    // 初始化时同步读 localStorage，确保首次渲染值正确
    const v = readLS();
    applyToDOM(v);
    return v;
  });

  useEffect(() => {
    // 注册到模块级监听列表
    _listeners.push(setHdr);

    // 同步到当前模块全局值（处理多实例场景）
    const current = _current;
    setHdr(current);
    applyToDOM(current);

    return () => {
      _listeners = _listeners.filter((fn) => fn !== setHdr);
    };
  }, []);

  const toggle = useCallback((value: boolean) => {
    try {
      localStorage.setItem(LS_KEY, String(value));
    } catch { /* ignore */ }
    applyToDOM(value);
    notifyAll(value);
  }, []);

  /**
   * 返回应用于 <img> 的 inline style。
   * 直接读 DOM attribute，不依赖 React state，永远实时准确。
   * - data-hdr="off"（默认）：加 filter 压制 HDR
   * - data-hdr="on"：原图，无 filter
   */
  const imgStyle = (): React.CSSProperties => {
    const isOn = document.documentElement.getAttribute("data-hdr") === "on";
    return isOn ? {} : { filter: "brightness(0.88) saturate(0.92)" };
  };

  return { hdr, toggle, imgStyle };
}
