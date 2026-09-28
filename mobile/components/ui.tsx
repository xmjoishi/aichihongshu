/**
 * 组件库 — 对齐 PC 端设计风格
 *
 * PC 端规范：白底卡片 / zinc 文字 / brand #ff2442 / rounded-xl(12px)
 *
 * - AuroraBackground   纯白页面背景（去掉光斑）
 * - LiquidCard         白底卡片，border-zinc-100 + 轻投影
 * - LiquidButton       PC 同款按钮（brand=红底白字 / glass=白底边框 / success=绿）
 * - LiquidInput        白底输入框，zinc 边框
 * - FloatingHeader     顶部导航（白底毛玻璃）
 * - InlineNav          子页面返回导航
 * - Badge / SectionLabel / Divider
 */
import React, { useRef, useCallback, useState, useEffect } from 'react';
import {
  View,
  Text,
  Image,
  ImageStyle,
  StyleSheet,
  ViewStyle,
  TextStyle,
  Platform,
  Pressable,
  TextInput,
  TextInputProps,
  Animated,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass, Brand, Text as TextTokens, Font, Radius, Border, BG, Sys } from '../utils/theme';
import { resolveLocalUri } from '../services/media';

// ═══════════════════════════════════════════════════════════════
// AuroraBackground — 纯白页面背景（保留旧名兼容）
// ═══════════════════════════════════════════════════════════════
interface AuroraBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export function AuroraBackground({ children, style }: AuroraBackgroundProps) {
  return (
    <View style={[{ flex: 1, backgroundColor: BG.page }, style]}>
      {children}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════
// LiquidCard — 白底卡片（对齐 PC 端 StatCard / bg-white rounded-xl border-zinc-100）
// ═══════════════════════════════════════════════════════════════
interface LiquidCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  onLongPress?: () => void;
  padding?: number;
  /** 不再使用，保留兼容 */
  intensity?: number;
  highlight?: boolean;
  refraction?: boolean;
}

export function LiquidCard({
  children,
  style,
  onPress,
  onLongPress,
  padding = 16,
}: LiquidCardProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  }, []);

  const onPressOut = useCallback(() => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();
  }, []);

  const inner = (
    <Animated.View style={[styles.card, { transform: [{ scale }] }, style]}>
      <View style={{ padding }}>{children}</View>
    </Animated.View>
  );

  if (onPress || onLongPress) {
    return (
      <Pressable onPress={onPress} onLongPress={onLongPress} onPressIn={onPressIn} onPressOut={onPressOut}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

// 向后兼容
export const GlassCard = LiquidCard;
export const Card = LiquidCard;

// ═══════════════════════════════════════════════════════════════
// LiquidButton — PC 同款按钮
//   brand  → 红底白字（PC: bg-[#ff2442] text-white）
//   glass  → 白底边框（PC: bg-white border-zinc-200 text-zinc-700）
//   success→ 绿底白字
// ═══════════════════════════════════════════════════════════════
interface LiquidButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'brand' | 'glass' | 'success' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  style?: ViewStyle;
  disabled?: boolean;
}

export function LiquidButton({
  label,
  onPress,
  variant = 'brand',
  size = 'md',
  style,
  disabled,
}: LiquidButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, speed: 50, bounciness: 4 }),
      Animated.timing(opacity, { toValue: 0.80, duration: 80, useNativeDriver: true }),
    ]).start();
  }, []);

  const onPressOut = useCallback(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 8 }),
      Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  }, []);

  const py = size === 'sm' ? 7 : size === 'lg' ? 14 : 11;
  const px = size === 'sm' ? 14 : size === 'lg' ? 28 : 20;
  const fontSize = size === 'sm' ? Font.footnote : size === 'lg' ? Font.callout : Font.subheadline;

  const btnStyle =
    variant === 'brand'   ? styles.btnBrand :
    variant === 'success' ? styles.btnSuccess :
    variant === 'ghost'   ? styles.btnGhost :
                            styles.btnGlass;
  const textStyle =
    variant === 'glass' || variant === 'ghost' ? styles.btnTextGlass : styles.btnTextWhite;

  return (
    <Pressable onPress={disabled ? undefined : onPress} onPressIn={onPressIn} onPressOut={onPressOut}>
      <Animated.View
        style={[
          styles.btnBase,
          btnStyle,
          { transform: [{ scale }], opacity: disabled ? 0.4 : opacity, paddingVertical: py, paddingHorizontal: px },
          style,
        ]}
      >
        <Text style={[textStyle, { fontSize }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

// 向后兼容
export const PillButton = LiquidButton;
export const TintButton = LiquidButton;

// ═══════════════════════════════════════════════════════════════
// LiquidInput — 白底输入框
// ═══════════════════════════════════════════════════════════════
interface LiquidInputProps extends TextInputProps {
  label?: string;
  containerStyle?: ViewStyle;
}

export function LiquidInput({ label, containerStyle, style, ...props }: LiquidInputProps) {
  return (
    <View style={[{ gap: 6 }, containerStyle]}>
      {label && <Text style={styles.inputLabel}>{label}</Text>}
      <View style={styles.inputWrap}>
        <TextInput
          style={[styles.inputField, style]}
          placeholderTextColor={TextTokens.tertiary}
          selectionColor={Brand.red}
          {...props}
        />
      </View>
    </View>
  );
}

// 向后兼容
export const GlassInput = LiquidInput;
export const FieldInput = LiquidInput;

export function Chip({
  label,
  tone = 'info',
  icon,
  style,
}: {
  label: string;
  tone?: 'info' | 'brand' | 'success';
  icon?: React.ReactNode;
  style?: ViewStyle;
}) {
  const bg =
    tone === 'brand' ? Brand.redSoft :
    tone === 'success' ? Sys.successBg :
    '#F4F4F5';
  const color =
    tone === 'brand' ? Brand.red :
    tone === 'success' ? Sys.success :
    TextTokens.secondary;
  const border = tone === 'brand' ? Brand.redMid : 'transparent';
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: Radius.pill, backgroundColor: bg, borderWidth: 1, borderColor: border }, style]}>
      {icon}
      <Text style={{ fontSize: Font.caption, color, fontWeight: Font.medium }}>{label}</Text>
    </View>
  );
}

export function Field({
  label,
  hint,
  children,
  right,
  style,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={styles.inputLabel}>{label}</Text>
        {right}
      </View>
      {children}
      {hint ? <Text style={{ fontSize: Font.caption, color: TextTokens.tertiary, lineHeight: 17 }}>{hint}</Text> : null}
    </View>
  );
}




















// ═══════════════════════════════════════════════════════════════
// Chip — 信息 / 强调 / 成功 三态

// ═══════════════════════════════════════════════════════════════
// Field — 标签 + 输入 + 提示（统一表单字段）



// ═══════════════════════════════════════════════════════════════
// GlassBackBar — iOS 原生玻璃返回栏（设置页同款）
// ═══════════════════════════════════════════════════════════════
export function GlassBackBar({
  title,
  backLabel = '返回',
  onBack,
  right,
}: {
  title?: string;
  backLabel?: string;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[gbb.wrap, { paddingTop: Math.max(insets.top, 12) + 6 }]}>
      <Pressable onPress={onBack} style={gbb.backBtn} hitSlop={8}>
        <Text style={gbb.chevron}>‹</Text>
        <Text style={gbb.backText} numberOfLines={1}>{backLabel}</Text>
      </Pressable>
      {title ? (
        <Text style={gbb.titlePlain} numberOfLines={1}>{title}</Text>
      ) : <View style={{ flex: 1 }} />}
      <View style={gbb.right}>{right}</View>
    </View>
  );
}

const gbb = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Glass.bgStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    minWidth: 72,
  },
  chevron: { fontSize: 22, color: TextTokens.primary, marginTop: -2 },
  backText: { fontSize: Font.subheadline, color: TextTokens.primary, fontWeight: Font.medium, maxWidth: 96 },
  titlePlain: {
    flex: 1,
    textAlign: 'center',
    fontSize: Font.subheadline,
    fontWeight: Font.semibold,
    color: TextTokens.primary,
  },
  right: { minWidth: 72, alignItems: 'flex-end' },
});

// ═══════════════════════════════════════════════════════════════
// FloatingHeader — 顶部导航（白底毛玻璃，systemMaterialLight）
// ═══════════════════════════════════════════════════════════════
interface FloatingHeaderProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  left?: React.ReactNode;
  large?: boolean;
}

export function FloatingHeader({ title, subtitle, right, left, large = false }: FloatingHeaderProps) {
  const insets = useSafeAreaInsets();
  return (
    <BlurView intensity={80} tint="systemMaterialLight" style={styles.header}>
      <View style={styles.headerBg} />
      <View style={styles.headerLine} />
      <View style={[styles.headerInner, { paddingTop: insets.top + 10 }]}>
        {left && <View style={styles.headerSide}>{left}</View>}
        <View style={[styles.headerCenter, !left && !right && { alignItems: 'flex-start' }]}>
          <Text style={large ? styles.headerTitleLg : styles.headerTitle}>{title}</Text>
          {subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
        </View>
        {right && <View style={[styles.headerSide, { alignItems: 'flex-end' }]}>{right}</View>}
      </View>
    </BlurView>
  );
}

// 向后兼容
export const GlassHeader = FloatingHeader;
export const PageHeader = FloatingHeader;

// ═══════════════════════════════════════════════════════════════
// PageTitleBlock — Tab 主页大标题（三页统一：相册 / 创作 / 设置）
// 上边距只压到 safe-area + 2，减少顶栏留白
// ═══════════════════════════════════════════════════════════════
export function PageTitleBlock({
  title,
  count,
  subtitle,
  right,
  children,
}: {
  title: string;
  /** 标题右侧小号数量，如「相册 8」 */
  count?: string | number;
  subtitle?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 2, paddingHorizontal: 18, paddingBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text style={{ fontSize: Font.title2, fontWeight: Font.bold, color: TextTokens.primary, lineHeight: 30 }}>
              {title}
            </Text>
            {count !== undefined && count !== null && (
              <Text style={{ fontSize: Font.caption, color: TextTokens.tertiary, fontWeight: '400' }}>
                {count}
              </Text>
            )}
          </View>
          {subtitle ? (
            <Text style={{ fontSize: Font.caption, color: TextTokens.tertiary, marginTop: 1 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════
// InlineNav — 子页面导航
// ═══════════════════════════════════════════════════════════════
interface InlineNavProps {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
}

export function InlineNav({ title, onBack, right }: InlineNavProps) {
  const insets = useSafeAreaInsets();
  return (
    <BlurView intensity={80} tint="systemMaterialLight" style={styles.header}>
      <View style={styles.headerBg} />
      <View style={styles.headerLine} />
      <View style={[styles.inlineInner, { paddingTop: insets.top + 10 }]}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.backLabel}>返回</Text>
        </Pressable>
        <Text style={styles.inlineTitle}>{title}</Text>
        <View style={styles.inlineRight}>{right}</View>
      </View>
    </BlurView>
  );
}

// 向后兼容
export const InlineHeader = InlineNav;

// ═══════════════════════════════════════════════════════════════
// Badge — 状态标签（对齐 PC 端 StatusBadge）
// ═══════════════════════════════════════════════════════════════
export function Badge({ label, color = Brand.red }: { label: string; color?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: color + '1A' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}
export const GlassBadge = Badge;

// ═══════════════════════════════════════════════════════════════
// SectionLabel
// ═══════════════════════════════════════════════════════════════
export function SectionLabel({ children, style }: { children: string; style?: TextStyle }) {
  return <Text style={[styles.sectionLabel, style]}>{children}</Text>;
}

// ═══════════════════════════════════════════════════════════════
// Divider
// ═══════════════════════════════════════════════════════════════
export function Divider({ style }: { style?: ViewStyle }) {
  return <View style={[styles.divider, style]} />;
}

// ═══════════════════════════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════════════════════════
const HEADER_PT = Platform.OS === 'ios' ? 54 : 16;

const styles = StyleSheet.create({
  // ── 卡片（白底 + 细边框 + 轻投影，对齐 PC StatCard）──────────
  card: {
    backgroundColor: BG.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Border.soft,
    // iOS 轻投影
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },

  // ── 按钮 ─────────────────────────────────────────────────────
  btnBase: {
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  btnBrand: {
    backgroundColor: Brand.red,
  },
  btnSuccess: {
    backgroundColor: Sys.success,
  },
  btnGhost: { backgroundColor: 'transparent' },
  btnGlass: {
    backgroundColor: BG.card,
    borderWidth: 1,
    borderColor: Border.base,
  },
  btnTextWhite: {
    color: '#FFFFFF',
    fontWeight: Font.semibold,
    letterSpacing: 0.1,
  },
  btnTextGlass: {
    color: TextTokens.secondary,
    fontWeight: Font.medium,
    letterSpacing: 0.1,
  },

  // ── 输入框（白底 zinc 边框）──────────────────────────────────
  inputLabel: {
    fontSize: Font.caption,
    color: TextTokens.tertiary,
    fontWeight: Font.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inputWrap: {
    backgroundColor: BG.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Border.base,
  },
  inputField: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: Font.body,
    color: TextTokens.primary,
  },

  // ── Header（白底毛玻璃）──────────────────────────────────────
  header: {
    overflow: 'hidden',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Border.soft,
  },
  headerBg: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(250,250,250,0.92)',
  },
  headerLine: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: Border.base,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
  headerSide: { width: 80 },
  headerCenter: { flex: 1 },
  headerTitle: {
    fontSize: Font.headline,
    fontWeight: Font.semibold,
    color: TextTokens.primary,
  },
  headerTitleLg: {
    fontSize: Font.title2,
    fontWeight: Font.bold,
    color: TextTokens.primary,
  },
  headerSubtitle: {
    fontSize: Font.caption,
    color: TextTokens.secondary,
    marginTop: 1,
  },

  // ── InlineNav ────────────────────────────────────────────────
  inlineInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minWidth: 72,
  },
  backChevron: {
    fontSize: 26,
    color: Brand.red,
    lineHeight: 30,
    fontWeight: Font.regular,
  },
  backLabel: {
    fontSize: Font.body,
    color: Brand.red,
    fontWeight: Font.regular,
  },
  inlineTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: Font.headline,
    fontWeight: Font.semibold,
    color: TextTokens.primary,
  },
  inlineRight: {
    minWidth: 72,
    alignItems: 'flex-end',
  },

  // ── Badge（对齐 PC StatusBadge：bg-xxx-100 text-xxx-600）─────
  badge: {
    borderRadius: Radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: Font.caption,
    fontWeight: Font.semibold,
  },

  // ── SectionLabel ─────────────────────────────────────────────
  sectionLabel: {
    fontSize: Font.caption,
    color: TextTokens.tertiary,
    fontWeight: Font.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginTop: 4,
  },

  // ── Divider ──────────────────────────────────────────────────
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Border.soft,
    marginVertical: 8,
  },
});

// ── PhImage ──────────────────────────────────────────────────────
/**
 * 渲染相册图片。ph:// 先经 resolveLocalUri（带缓存）换成 file:// 再渲染
 * （New Architecture 下 RN Image 不认 ph://）。
 * 用法与 <Image> 完全相同，只需把 source={{ uri }} 换成 <PhImage uri={...} />
 */
export function PhImage({
  uri,
  style,
  resizeMode = 'cover',
}: {
  uri: string;
  style?: ImageStyle | ImageStyle[];
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'center';
}) {
  const [localUri, setLocalUri] = useState<string | null>(
    uri.startsWith('ph://') ? null : uri
  );
  const [resolving, setResolving] = useState(uri.startsWith('ph://'));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!uri.startsWith('ph://')) {
      setLocalUri(uri);
      setResolving(false);
      return;
    }
    setLocalUri(null);
    setResolving(true);
    let cancelled = false;
    resolveLocalUri(uri)
      .then((u) => {
        if (cancelled) return;
        setResolving(false);
        if (u.startsWith('ph://')) setFailed(true);
        else setLocalUri(u);
      })
      .catch(() => {
        if (cancelled) return;
        setResolving(false);
        setFailed(true);
      });
    return () => { cancelled = true; };
  }, [uri]);

  if (resolving) {
    return <View style={[{ backgroundColor: '#e5e5e5' }, style as ViewStyle]} />;
  }
  if (!localUri || failed) {
    return (
      <View style={[{ backgroundColor: '#e5e5e5', alignItems: 'center', justifyContent: 'center' }, style as ViewStyle]}>
        <Text style={{ color: '#737373', fontSize: 12 }}>原图不可访问</Text>
      </View>
    );
  }
  return <Image source={{ uri: localUri }} style={style} resizeMode={resizeMode} onError={() => setFailed(true)} />;
}
