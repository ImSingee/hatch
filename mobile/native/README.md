# Native App runtime (iOS and Android)

Runs Hatch `native` Apps on the phone: one NSH engine per App, owned here and
not by any view, each running the App's signed package from the instance. No
React Native or Expo in here: the Expo app reaches it through the thin module
`mobile/modules/hatch-app-view`, and another host could use it as is.

| Path                          | What                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nsh-sdk.json`                | The NSH embedding SDK: release URL and SHA-256 per platform (NSH 0.7.0).                                                                                                |
| `scripts/fetch-nsh-sdk.mjs`   | Downloads and checks the SDK into `ios/vendor` and `android/vendor` (gitignored). The config plugin `mobile/plugins/with-hatch-native-runtime.cjs` runs it at prebuild. |
| `ios/HatchAppCore`            | Swift package, Foundation only: the host bridge, the platform client, the run rules.                                                                                    |
| `ios/HatchAppRuntime`         | Swift package: the engine manager (UIKit, NSH).                                                                                                                         |
| `ios/HatchAppRuntime.podspec` | Both packages as one pod for the Expo app; the only pod that links NSH.                                                                                                 |
| `android/core`                | Kotlin (JVM): the same core.                                                                                                                                            |
| `android/runtime`             | Android library: the engine manager (NSH's `nsh.aar`).                                                                                                                  |
| `fixtures/grant-probe`        | The engine tests' fixture App.                                                                                                                                          |

## What every engine gets

- Its App's package from `GetAppPackage` (the session's bearer), checked for
  size and SHA-256, verified by a trust store per instance with the roots and
  revocation list of `GetAppRuntimeTrust`. The store refuses older builds.
- A 96 MB heap and exactly the grant `{ "host": [the nine hatch.* calls] }`.
  The grant is always set: without one NSH lets a package do whatever it
  declares (the engine tests show both).
- `host.params`: `platform`, `route` and `packageBuild` (the package header's
  build; NSH's `appInfo().build` is the bundle's compiled-in 1).
- A bridge that checks every argument and builds every request from the App's
  own scope: `/api/app/<its id>/rpc/...` and `/data/...`, data calls with the
  live deployment in `x-hatch-data-deployment`.

## Run rules (as the web Desk)

One engine per App. Leaving an App's page hides it; the engine keeps
running. At the limit (3 running Apps on a phone, 6 on a tablet) the App shown
least recently stops. A hidden App, or every App while the whole app is in the
background, stops after the user's background minutes
(`GetDeskPreferences`). A stopped App reopens at its last route; one whose
page stayed open starts again when the app returns.

## Tests

- CI (`mobile-native` job): `swift test` in `ios/HatchAppCore` and
  `./gradlew :hatch-app-core:test` in `android`.
- Engines (local): `scripts/test-ios.sh` (iOS Simulator; needs Xcode, nsh and
  xcodegen) and `scripts/test-android.sh` (a device or emulator; needs the
  Android SDK and nsh).
