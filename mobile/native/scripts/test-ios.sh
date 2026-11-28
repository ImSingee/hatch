#!/bin/sh
# Tests the iOS native runtime: the core with `swift test`, then the runtime
# on a real NSH engine in the iOS Simulator (`HATCH_IOS_SIMULATOR` names one,
# by name or UDID; default: the first available iPhone). Needs Xcode, nsh
# and xcodegen.
set -eu
native="$(cd "$(dirname "$0")/.." && pwd)"
node "$native/scripts/fetch-nsh-sdk.mjs" ios
(cd "$native/ios/HatchAppCore" && swift test)
fixtures="$native/ios/RuntimeTests/Fixtures"
rm -rf "$fixtures/grant-probe"
(cd "$native/fixtures/grant-probe" && nsh build App.tsx --out "$fixtures/grant-probe")
simulator="${HATCH_IOS_SIMULATOR:-$(xcrun simctl list devices available | sed -n 's/^ *\(iPhone[^(]*\) (\([0-9A-F-]*\)).*/\2/p' | head -n 1)}"
case "$simulator" in
  *-*-*-*-*) destination="platform=iOS Simulator,id=$simulator" ;;
  *) destination="platform=iOS Simulator,name=$simulator" ;;
esac
cd "$native/ios/RuntimeTests"
xcodegen generate --quiet
xcodebuild test -project HatchRuntimeTests.xcodeproj -scheme HatchAppRuntimeTests -destination "$destination" -quiet
