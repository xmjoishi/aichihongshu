import { Tabs } from 'expo-router';
import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  LayoutChangeEvent, Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useAnimatedStyle,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Rect, Line, Polyline } from 'react-native-svg';
import { Brand, Font } from '../../utils/theme';

// ─── Spring / Timing 配置 ───────────────────────────────────────
const SPRING = { damping: 22, stiffness: 320, mass: 0.45 };
const TIMING = { duration: 140, easing: Easing.out(Easing.quad) };

// ─── SVG 图标 ────────────────────────────────────────────────────
function IconLibrary({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Rect x="2" y="5" width="16" height="14" rx="3" stroke={color} strokeWidth="1.6" />
      <Path d="M5 17l4-4.5 3 3 2-2.5 4 4" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="7.5" cy="10" r="1.3" fill={color} />
      <Path d="M6 5V4a1 1 0 011-1h13a2 2 0 012 2v11a1 1 0 01-1 1h-1" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </Svg>
  );
}
function IconCreate({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IconPublish({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <Polyline points="17 8 12 3 7 8" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <Line x1="12" y1="3" x2="12" y2="15" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}
function IconProfile({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="12" cy="7" r="4" stroke={color} strokeWidth="1.6" />
    </Svg>
  );
}

const ICONS = [IconLibrary, IconCreate, IconPublish, IconProfile];

// ─── 单个 Tab Item ────────────────────────────────────────────────
type TabItemProps = {
  isFocused: boolean;
  label: string;
  onPress: () => void;
  color: string;
  renderIcon?: (props: { focused: boolean; color: string; size: number }) => React.ReactNode;
};

function TabItem({ isFocused, label, onPress, color, renderIcon }: TabItemProps) {
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: withTiming(isFocused ? 1 : 0.88, TIMING) }],
    opacity: withTiming(1, TIMING),
  }));

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={styles.tabItem}
      accessibilityRole="button"
    >
      <Animated.View style={[styles.tabContent, animStyle]}>
        {renderIcon?.({ focused: isFocused, color, size: 22 })}
        <Text style={[styles.tabLabel, { color }]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── 浮动胶囊 Tab Bar ─────────────────────────────────────────────
function FloatingTabBar({
  state,
  descriptors,
  navigation,
}: {
  state: any;
  descriptors: any;
  navigation: any;
}) {
  const insets = useSafeAreaInsets();
  const [pillWidth, setPillWidth] = useState(0);

  const visibleRoutes = (state.routes as any[]).filter(
    (route: any) => !(descriptors[route.key].options as any).tabBarHidden
  );
  const focusedIdx = visibleRoutes.findIndex(
    (r: any) => r.key === state.routes[state.index].key
  );
  const tabW = pillWidth > 0 ? pillWidth / visibleRoutes.length : 0;

  // Sliding indicator（跟随激活 tab 的背景高亮）
  const indicatorAnim = useAnimatedStyle(() => {
    if (tabW === 0) return { opacity: 0 };
    return {
      opacity: withTiming(1, { duration: 80 }),
      width: tabW - 12,
      transform: [
        { translateX: withSpring(Math.max(0, focusedIdx) * tabW + 6, SPRING) },
      ],
    };
  });

  return (
    <View
      style={[
        styles.outerContainer,
        { paddingBottom: Math.max(insets.bottom, 8) + 4 },
      ]}
      pointerEvents="box-none"
    >
      {/* 红色边框包裹层（border 不受 overflow:hidden 裁剪） */}
      <View style={styles.pillBorder}>
        {/* 整个 Tab Bar 是一个大胶囊 */}
        <View
          style={styles.pill}
          onLayout={(e: LayoutChangeEvent) =>
            setPillWidth(e.nativeEvent.layout.width)
          }
        >
          {/* 系统毛玻璃材质（关键：systemMaterialLight 比 light 更真实） */}
          <BlurView
            intensity={72}
            tint="systemMaterialLight"
            style={StyleSheet.absoluteFill}
          />

          {/* fallback 白色半透明底 */}
          <View style={styles.pillBg} />

          {/* 激活 indicator — 在 tabs 行下方，spring 滑动 */}
          {tabW > 0 && (
            <Animated.View style={[styles.indicator, indicatorAnim]} />
          )}

          {/* Tabs */}
          <View style={styles.tabsRow}>
            {visibleRoutes.map((route: any, index: number) => {
              const { options } = descriptors[route.key];
              const isFocused = index === focusedIdx;
              const label =
                (options.tabBarLabel as string) ??
                options.title ??
                route.name;
              const color = isFocused ? '#ffffff' : '#18181b';

              const onPress = () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!isFocused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params as object);
                }
              };

              return (
                <TabItem
                  key={route.key}
                  isFocused={isFocused}
                  label={label}
                  onPress={onPress}
                  color={color}
                  renderIcon={options.tabBarIcon}
                />
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Layout ───────────────────────────────────────────────────────
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <FloatingTabBar {...props} />}
    >
      <Tabs.Screen
        name="library"
        options={{
          title: '图库',
          tabBarIcon: ({ color }) => <IconLibrary color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="create"
        options={{
          title: '创作',
          tabBarIcon: ({ color }) => <IconCreate color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '设置',
          tabBarIcon: ({ color }) => <IconProfile color={color as string} />,
        }}
      />
    </Tabs>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const styles = StyleSheet.create({
  outerContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    // 不拦截 Tab Bar 以外区域的触摸
  },
  pillBorder: {
    width: '88%',
    maxWidth: 380,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,36,66,0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 6,
  },
  pill: {
    flexDirection: 'row',
    width: '100%',
    height: 62,
    borderRadius: 31,
    overflow: 'hidden',
  },
  pillBg: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  indicator: {
    position: 'absolute',
    height: '78%',
    top: '11%',
    borderRadius: 24,
    backgroundColor: Brand.red,
    zIndex: 0,
  },
  tabsRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  tabItem: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabLabel: {
    fontSize: Font.caption2,
    fontWeight: Font.semibold,
    letterSpacing: 0.1,
  },
});
