// metro.config.js
// 修复 pnpm 扁平化依赖下的路径解析问题

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver ?? {};
const originalResolveRequest = config.resolver.resolveRequest;

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
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
