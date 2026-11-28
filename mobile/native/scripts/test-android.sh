#!/bin/sh
# Tests the Android native runtime: the core's JVM tests, then the runtime on
# a real NSH engine on the connected device or emulator (adb). Needs the
# Android SDK (ANDROID_HOME) and nsh.
set -eu
native="$(cd "$(dirname "$0")/.." && pwd)"
node "$native/scripts/fetch-nsh-sdk.mjs" android
assets="$native/android/runtime/src/androidTest/assets"
rm -rf "$assets/grant-probe"
(cd "$native/fixtures/grant-probe" && nsh build App.tsx --out "$assets/grant-probe")
cd "$native/android"
./gradlew :hatch-app-core:test :hatch-app-runtime:connectedDebugAndroidTest
