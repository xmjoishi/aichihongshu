// metro.config.js
// 修复 pnpm/扁平化依赖下的路径解析问题

const { getDefaultConfig } = require('expo/metro-config');
const { resolve } = require('metro-resolver');
const path = require('path');

const config = getDefaultConfig(__dirname);

const legacyBuildPath = path.resolve(
  __dirname,
  'node_modules/expo-media-library/build/legacy/index.js'
);

const rnFeatureFlagsPath = path.resolve(
  __dirname,
  'node_modules/react-native/src/private/featureflags/ReactNativeFeatureFlags.js'
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-media-library/legacy') {
    return { filePath: legacyBuildPath, type: 'sourceFile' };
  }
  if (moduleName === 'react-native/src/private/featureflags/ReactNativeFeatureFlags') {
    return { filePath: rnFeatureFlagsPath, type: 'sourceFile' };
  }
  // 必须回到 metro-resolver，否则相对导入（如 reanimated 的 ./BaseAnimationBuilder）无法命中 .ts
  return resolve(context, moduleName, platform);
};

module.exports = config;
