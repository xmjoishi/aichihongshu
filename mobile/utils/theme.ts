/**
 * 设计 Token — 对齐 PC 端风格
 *
 * PC 端规范（client/src/index.css）：
 *   brand: #ff2442
 *   surface: #fafafa
 *   surface-2: #f4f4f5
 *   card: #ffffff
 *   radius-card: 12px
 *   font: PingFang SC / system-ui
 *
 * Tab Bar 用 iOS Liquid Glass 材质（systemMaterialLight）
 */

// ── 品牌色 ────────────────────────────────────────────────────────
export const Brand = {
  red: '#FF2442',
  redLight: '#fff1f3',   // bg-[#fff1f3]，激活态背景
  redMid: 'rgba(255,36,66,0.15)',
  redSoft: 'rgba(255,36,66,0.08)',
};

// ── 背景面（与 PC 端一致）────────────────────────────────────────
export const BG = {
  page: '#FAFAFA',       // --color-surface
  page2: '#F4F4F5',      // --color-surface-2
  card: '#FFFFFF',       // 卡片白
  separator: '#F4F4F5',  // 分割线 / border-zinc-100
};

// ── 文字（zinc scale，与 PC 端 Tailwind 一致）──────────────────
export const Text = {
  primary: '#18181B',    // zinc-900
  secondary: '#71717A',  // zinc-500
  tertiary: '#A1A1AA',   // zinc-400
  quaternary: '#D4D4D8', // zinc-300
  tint: '#FF2442',       // brand
  onRed: '#FFFFFF',
};

// ── 描边（zinc scale）────────────────────────────────────────────
export const Border = {
  base: '#E4E4E7',       // zinc-200
  soft: '#F4F4F5',       // zinc-100
  brand: 'rgba(255,36,66,0.20)',
};

// ── Glass（仅用于 Tab Bar / 浮层，不用于内容卡片）───────────────
export const Glass = {
  // Tab Bar 背景 fallback
  bg: 'rgba(255,255,255,0.82)',
  bgStrong: 'rgba(255,255,255,0.95)',
  // 胶囊高光边（Liquid Glass 特征）
  highlightBorder: 'rgba(255,255,255,0.90)',
  border: 'rgba(0,0,0,0.08)',
  borderSoft: 'rgba(0,0,0,0.05)',
  borderSubtle: 'rgba(0,0,0,0.04)',
  // 用于向后兼容（旧组件引用）
  bgMed: 'rgba(255,255,255,0.88)',
  dark: 'rgba(0,0,0,0.04)',
  darkMed: 'rgba(0,0,0,0.07)',
  highlightTop: 'rgba(255,255,255,0.90)',
  highlightBot: 'rgba(255,255,255,0.00)',
  refractionLeft: 'rgba(255,255,255,0.50)',
  refractionRight: 'rgba(255,255,255,0.00)',
  shadowColor: 'rgba(0,0,0,0.06)',
  blurLight: 16,
  blurMed: 28,
  blurStrong: 50,
  blurUltra: 70,
};

// ── 系统色 ────────────────────────────────────────────────────────
export const Sys = {
  success: '#16A34A',      // green-600（PC 端 bg-green-100 / text-green-600）
  successBg: '#DCFCE7',    // green-100
  warning: '#D97706',      // amber-600
  warningBg: '#FEF3C7',    // amber-100
  destructive: '#FF2442',
};

// ── 圆角（对齐 PC 端 rounded-xl = 12px）─────────────────────────
export const Radius = {
  sm: 8,
  md: 12,    // rounded-xl，PC 端主圆角
  lg: 16,
  xl: 20,
  xxl: 28,
  pill: 9999,
};

// ── 字体 ─────────────────────────────────────────────────────────
export const Font = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  heavy: '800' as const,

  caption2: 10,
  caption: 12,
  footnote: 13,
  subheadline: 15,
  callout: 16,
  body: 17,
  headline: 17,
  title3: 20,
  title2: 22,
  title1: 28,
  largeTitle: 34,
};

// ── 间距 ─────────────────────────────────────────────────────────
export const Space = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

// ── Aurora（保留 export 兼容旧引用，但不再使用）─────────────────
export const Aurora = {
  base: '#FAFAFA',
  baseAlt: '#FFFFFF',
  orb1: 'transparent', orb2: 'transparent',
  orb3: 'transparent', orb4: 'transparent',
  gradient: ['#FAFAFA', '#FAFAFA', '#FAFAFA'] as const,
};
