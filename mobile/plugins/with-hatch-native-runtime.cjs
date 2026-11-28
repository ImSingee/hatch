/**
 * Wires Hatch's native App runtime (`mobile/native`, no React Native in it)
 * into the prebuilt projects:
 *
 * - fetches the NSH embedding SDK that `native/nsh-sdk.json` pins (version
 *   and SHA-256), when a platform's project is generated, never when the
 *   config is only read (`expo export` reads it too);
 * - iOS: the `HatchAppRuntime` pod (`native/ios`), the only one that links
 *   NSH's static framework;
 * - Android: the `:hatch-app-core` and `:hatch-app-runtime` projects, the
 *   local Maven repository with `nsh.aar`, minSdk 26 (NSH's) and no x86
 *   (nsh.aar has no x86 library).
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  withDangerousMod,
  withGradleProperties,
  withPodfile,
  withProjectBuildGradle,
  withSettingsGradle,
} = require('expo/config-plugins');

const NATIVE = path.join(__dirname, '..', 'native');
const ANDROID_ARCHITECTURES = 'armeabi-v7a,arm64-v8a,x86_64';
const ANDROID_MIN_SDK = '26';

function fetchSdk(platform) {
  execFileSync(
    process.execPath,
    [path.join(NATIVE, 'scripts', 'fetch-nsh-sdk.mjs'), platform],
    { stdio: 'inherit' },
  );
}

/** Adds `block` after the line containing `anchor`, once (marked by `marker`). */
function insertAfter(contents, anchor, marker, block, what) {
  if (contents.includes(marker)) return contents;
  const index = contents.indexOf(anchor);
  if (index < 0) throw new Error(`Cannot wire the Hatch App runtime: ${what}.`);
  const end = contents.indexOf('\n', index) + 1;
  return contents.slice(0, end) + block + contents.slice(end);
}

function withIos(config) {
  config = withDangerousMod(config, [
    'ios',
    (config) => {
      fetchSdk('ios');
      return config;
    },
  ]);
  return withPodfile(config, (config) => {
    config.modResults.contents = insertAfter(
      config.modResults.contents,
      'use_expo_modules!',
      "pod 'HatchAppRuntime'",
      "  # Hatch's native App runtime (mobile/native), with the NSH SDK.\n" +
        "  pod 'HatchAppRuntime', :path => '../native/ios'\n",
      'the Podfile has no use_expo_modules!',
    );
    return config;
  });
}

function withAndroid(config) {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      fetchSdk('android');
      return config;
    },
  ]);
  config = withSettingsGradle(config, (config) => {
    const marker = "include ':hatch-app-runtime'";
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents += `
// Hatch's native App runtime (mobile/native/android).
include ':hatch-app-core'
project(':hatch-app-core').projectDir = new File(rootDir, '../native/android/core')
${marker}
project(':hatch-app-runtime').projectDir = new File(rootDir, '../native/android/runtime')
`;
    }
    return config;
  });
  config = withProjectBuildGradle(config, (config) => {
    config.modResults.contents = insertAfter(
      config.modResults.contents,
      "maven { url 'https://www.jitpack.io' }",
      'native/android/vendor/maven',
      "    // NSH's nsh.aar (mobile/native/scripts/fetch-nsh-sdk.mjs).\n" +
        '    maven { url "${rootDir}/../native/android/vendor/maven" }\n',
      'the root build.gradle has no allprojects repositories',
    );
    return config;
  });
  return withGradleProperties(config, (config) => {
    const set = (key, value) => {
      const entry = config.modResults.find(
        (item) => item.type === 'property' && item.key === key,
      );
      if (entry) entry.value = value;
      else config.modResults.push({ type: 'property', key, value });
    };
    set('android.minSdkVersion', ANDROID_MIN_SDK);
    set('reactNativeArchitectures', ANDROID_ARCHITECTURES);
    return config;
  });
}

module.exports = function withHatchNativeRuntime(config) {
  return withAndroid(withIos(config));
};
