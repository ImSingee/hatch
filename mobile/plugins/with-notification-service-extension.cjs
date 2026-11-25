const fs = require('node:fs');
const path = require('node:path');
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const TARGET = 'HatchNotificationService';
const SHARED_GROUP_SUFFIX = 'app.hatch.mobile.shared';
const SHARED_GROUP = `$(AppIdentifierPrefix)${SHARED_GROUP_SUFFIX}`;
const KEYCHAIN_SERVICE = 'app.hatch.mobile.push-keys';
const UNVERIFIED_BODY = 'Notification from an unverified source';

// Decrypts Hatch's end-to-end encrypted pushes. Apple only ever sees the
// placeholder alert and ciphertext; anything that fails authentication is
// shown as unverified with every sender-controlled field removed.
const SWIFT = `import CryptoKit
import Foundation
import Security
import UserNotifications

struct HatchPushPlaintext: Decodable {
  let v: Int
  let id: String
  let o: String
  let t: String
  let b: String?
  let s: String
  let k: String
  let g: String
  let u: String?
  let ao: Bool?
  let at: String
  /// Notification revision (absent from instances that predate edits).
  let r: Int?
  /// "u": edit of a shown notification; "r": recall (carries no content).
  let e: String?
  /// An edit should alert again (absent on historical silent edits).
  let a: Bool?
  /// Reply form, as the phone offers it (absent when it asks nothing).
  let q: HatchPushReply?
  /// 1: the title already names the source (Markdown and card
  /// notifications), so the subtitle is the kind alone.
  let ks: Int?
}

/// "b": buttons of field \`f\`; "t": system text reply for field \`f\`; "f": open
/// the form in the app; "x": already answered (\`s\` says by whom and what).
struct HatchPushReply: Decodable {
  struct Option: Decodable {
    let i: String
    let l: String
    let d: Int?
  }
  let m: String
  let f: String?
  let a: [Option]?
  let l: String?
  let p: String?
  let s: String?
}

/// Reply actions on notifications. Keep the identifiers in sync with
/// \`HatchReplyDelegate\` in modules/hatch-push-keys and mobile/src/core/push.ts.
enum HatchReplyActions {
  static let categoryPrefix = "hatch.reply."
  static let optionPrefix = "hatch.reply.option."
  static let text = "hatch.reply.text"
  static let form = "hatch.reply.form"
  /// Categories kept for older notifications that may still be answered.
  static let keep = 64

  static func category(for message: HatchPushPlaintext) -> UNNotificationCategory? {
    guard let reply = message.q else { return nil }
    let identifier = categoryPrefix + message.id
    switch reply.m {
    case "b":
      let actions = (reply.a ?? []).prefix(4).map { option in
        UNNotificationAction(
          identifier: optionPrefix + option.i,
          title: option.l,
          // Answers are final: unlock first, so nobody answers from a
          // locked phone.
          options: option.d == 1 ? [.destructive, .authenticationRequired] : [.authenticationRequired])
      }
      return actions.isEmpty ? nil : UNNotificationCategory(
        identifier: identifier, actions: Array(actions), intentIdentifiers: [], options: [])
    case "t":
      return UNNotificationCategory(
        identifier: identifier,
        actions: [
          UNTextInputNotificationAction(
            identifier: text, title: "Reply", options: [.authenticationRequired],
            textInputButtonTitle: reply.l ?? "Send", textInputPlaceholder: reply.p ?? "")
        ],
        intentIdentifiers: [], options: [])
    case "f":
      return UNNotificationCategory(
        identifier: identifier,
        actions: [UNNotificationAction(identifier: form, title: "Answer…", options: [.foreground])],
        intentIdentifiers: [], options: [])
    default:
      return nil
    }
  }

  /// Registers the notification's own category (its buttons come from the
  /// decrypted push), keeping the newest ones; ids are time-ordered.
  /// Registrations run one at a time: \`setNotificationCategories\` replaces
  /// the whole set, so two overlapping read-modify-writes in this process
  /// could drop each other's category.
  private static let queue = DispatchQueue(label: "app.hatch.mobile.reply-categories")

  /// One registration's write permission: a callback that arrives after the
  /// registration gave up must not write its stale snapshot over a newer one.
  private final class Attempt {
    let lock = NSLock()
    var abandoned = false
  }

  static func register(_ category: UNNotificationCategory, then done: @escaping () -> Void) {
    queue.async {
      let center = UNUserNotificationCenter.current()
      let finished = DispatchSemaphore(value: 0)
      let attempt = Attempt()
      center.getNotificationCategories { existing in
        // Read, decide and write while holding the attempt's lock, so giving
        // up below either waits for this write or stops it entirely.
        attempt.lock.lock()
        defer { attempt.lock.unlock() }
        guard !attempt.abandoned else { return }
        let others = existing.filter { !$0.identifier.hasPrefix(categoryPrefix) }
        let replies = existing
          .filter { $0.identifier.hasPrefix(categoryPrefix) && $0.identifier != category.identifier }
          .sorted { $0.identifier > $1.identifier }
          .prefix(keep - 1)
        center.setNotificationCategories(others.union(replies).union([category]))
        finished.signal()
      }
      // Bounded, so a stuck callback never holds the extension past its time.
      if finished.wait(timeout: .now() + 5) == .timedOut {
        attempt.lock.lock()
        attempt.abandoned = true
        attempt.lock.unlock()
      }
      done()
    }
  }
}

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let unverified = Self.unverified(request.content)
    lock.lock()
    deliver = contentHandler
    fallback = unverified
    lock.unlock()
    guard let opened = Self.open(request.content, key: Self.key(for:)) else {
      finish(unverified)
      return
    }
    let (message, content) = opened
    // Past this point the push is authentic; never fall back to "unverified".
    lock.lock()
    fallback = content
    lock.unlock()
    if message.e != "r", let category = HatchReplyActions.category(for: message) {
      HatchReplyActions.register(category) {
        self.present(message, content)
      }
    } else {
      present(message, content)
    }
  }

  private func present(_ message: HatchPushPlaintext, _ content: UNNotificationContent) {
    guard message.e == "u" || message.e == "r" else {
      finish(content)
      return
    }
    // Edits and recalls replace the notification with the same identifier
    // (the APNs collapse id is the notification id). With the filtering
    // entitlement a recall removes it outright, and an edit of a notification
    // that is already newer shows nothing. Only silent edits are suppressed
    // when the original is no longer shown; alerting edits may reappear.
    let filtering = Self.canFilter()
    UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
      let shown = delivered.filter { notification in
        let data = notification.request.content.userInfo["body"] as? [String: Any]
        return notification.request.identifier == message.id
          && (data?["hatchOrigin"] as? String) == message.o
      }
      if message.e == "r" {
        guard filtering else { return self.finish(content) }
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: shown.map { $0.request.identifier })
        return self.finish(UNNotificationContent())
      }
      let newest = shown.compactMap { notification in
        (notification.request.content.userInfo["body"] as? [String: Any])?["hatchRevision"] as? Int
      }.max()
      if filtering, (shown.isEmpty && message.a != true) || (newest ?? 0) >= (message.r ?? 0) {
        return self.finish(UNNotificationContent())
      }
      self.finish(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let fallback = fallback
    lock.unlock()
    if let fallback { finish(fallback) }
  }

  /// Hands content to the system once; later calls do nothing.
  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let handler = deliver
    deliver = nil
    lock.unlock()
    handler?(content)
  }

  /// Whether this build carries the notification filtering entitlement.
  static func canFilter() -> Bool {
    Bundle.main.object(forInfoDictionaryKey: "HatchNotificationFiltering") as? Bool == true
  }

  static func unverified(_ original: UNNotificationContent) -> UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "Hatch"
    content.body = "${UNVERIFIED_BODY}"
    content.sound = original.sound
    content.threadIdentifier = "hatch.unverified"
    content.userInfo = [:]
    return content
  }

  private static func sharedGroup() -> String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "HatchSharedKeychainGroup") as? String,
          !group.isEmpty, !group.contains("$(") else { return nil }
    return group
  }

  static func key(for kid: String) -> SymmetricKey? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "${KEYCHAIN_SERVICE}",
      kSecAttrAccount as String: kid,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    if let group = sharedGroup() { query[kSecAttrAccessGroup as String] = group }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data, data.count == 32 else { return nil }
    return SymmetricKey(data: data)
  }

  /// Keep in sync with \`HatchPushTap\` in modules/hatch-push-keys, which verifies it.
  static func tapSignature(origin: String, id: String, url: String, key: SymmetricKey) -> String {
    let tapKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: key, info: Data("hatch-tap-v1".utf8), outputByteCount: 32)
    let message = "hatch-tap-v1|\\(origin.utf8.count)|\\(origin)|\\(id.utf8.count)|\\(id)|\\(url.utf8.count)|\\(url)"
    return Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: tapKey)).base64EncodedString()
  }

  /// Keep in sync with \`HatchReplyTap\` in modules/hatch-push-keys, which
  /// verifies it before sending an answer to \`origin\`.
  static func replySignature(origin: String, id: String, field: String, key: SymmetricKey) -> String {
    let replyKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: key, info: Data("hatch-reply-tap-v1".utf8), outputByteCount: 32)
    let message = "hatch-reply-tap-v1|\\(origin.utf8.count)|\\(origin)|\\(id.utf8.count)|\\(id)|\\(field.utf8.count)|\\(field)"
    return Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: replyKey)).base64EncodedString()
  }

  /// Returns nil unless the payload authenticates with this phone's key.
  static func open(
    _ original: UNNotificationContent, key lookup: (String) -> SymmetricKey?
  ) -> (HatchPushPlaintext, UNNotificationContent)? {
    guard let envelope = original.userInfo["h"] as? [String: Any],
          (envelope["v"] as? Int) == 1,
          let kid = envelope["kid"] as? String,
          kid.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil,
          let sealed = envelope["c"] as? String,
          let combined = Data(base64Encoded: sealed),
          let key = lookup(kid),
          let box = try? AES.GCM.SealedBox(combined: combined),
          let plain = try? AES.GCM.open(
            box, using: key, authenticating: Data("hatch-push-v1|\\(kid)".utf8)),
          let message = try? JSONDecoder().decode(HatchPushPlaintext.self, from: plain),
          message.v == 1, !message.id.isEmpty,
          let origin = URL(string: message.o), ["https", "http"].contains(origin.scheme ?? "")
    else { return nil }

    let content = UNMutableNotificationContent()
    content.title = message.t
    content.subtitle = message.ks == 1 ? message.k : "\\(message.s) · \\(message.k)"
    content.body = message.b ?? ""
    content.sound = original.sound
    content.interruptionLevel = original.interruptionLevel
    content.threadIdentifier = "\\(message.o)|\\(message.g)"
    // expo-notifications exposes a remote push's \`body\` dictionary as \`data\`.
    var data: [String: Any] = ["hatchNotificationId": message.id, "hatchOrigin": message.o]
    if let revision = message.r { data["hatchRevision"] = revision }
    if message.e == "u" { data["hatchEvent"] = "updated" }
    if message.e == "u", message.a == true { data["hatchAlert"] = true }
    if message.e == "r" { data["hatchEvent"] = "recalled" }
    if let url = message.u {
      data["hatchUrl"] = url
      // A push that skips this extension can write the same fields, so the
      // app opens the URL on tap only with this phone's signature over them.
      if message.ao == true {
        data["hatchAutoOpenUrl"] = true
        data["hatchKid"] = kid
        data["hatchTapMac"] = tapSignature(origin: message.o, id: message.id, url: url, key: key)
      }
    }
    if let reply = message.q {
      if reply.m == "x", let summary = reply.s, !summary.isEmpty {
        content.body = content.body.isEmpty ? summary : "\\(content.body)\\n\\(summary)"
      } else if message.e != "r", HatchReplyActions.category(for: message) != nil {
        content.categoryIdentifier = HatchReplyActions.categoryPrefix + message.id
        data["hatchReply"] = reply.m
        if let field = reply.f, reply.m == "b" || reply.m == "t" {
          // Answering from the notification posts to \`hatchOrigin\`; the app
          // does so only with this phone's signature over these fields.
          data["hatchReplyField"] = field
          data["hatchKid"] = kid
          data["hatchReplyMac"] = replySignature(origin: message.o, id: message.id, field: field, key: key)
        }
      }
    }
    content.userInfo = ["body": data]
    return (message, content)
  }
}
`;

function extensionInfoPlist(version, buildNumber, filtering) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>Hatch Notifications</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${buildNumber}</string>
  <key>HatchSharedKeychainGroup</key>
  <string>${SHARED_GROUP}</string>
  <key>HatchNotificationFiltering</key>
  <${filtering ? 'true' : 'false'}/>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;
}

function extensionEntitlements(apnsEnvironment, filtering) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>aps-environment</key>
  <string>${apnsEnvironment}</string>
  <key>keychain-access-groups</key>
  <array>
    <string>${SHARED_GROUP}</string>
  </array>${
    filtering
      ? `
  <key>com.apple.developer.usernotifications.filtering</key>
  <true/>`
      : ''
  }
</dict>
</plist>
`;
}

function withMainAppKeychain(config) {
  config = withEntitlementsPlist(config, (config) => {
    // Keep the app's own group first: it stays the default for every other
    // keychain item (session tokens never move into the shared group).
    const own = '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)';
    const groups = Array.isArray(config.modResults['keychain-access-groups'])
      ? config.modResults['keychain-access-groups']
      : [];
    const next = [own, ...groups.filter((group) => group !== own)];
    if (!next.includes(SHARED_GROUP)) next.push(SHARED_GROUP);
    config.modResults['keychain-access-groups'] = next;
    return config;
  });
  return withInfoPlist(config, (config) => {
    config.modResults.HatchSharedKeychainGroup = SHARED_GROUP;
    return config;
  });
}

/**
 * High-priority pushes are time-sensitive: shown during Focus and Do Not
 * Disturb unless the user turns that off for Hatch. The capability needs no
 * Apple approval, unlike critical alerts; without it iOS shows them as
 * ordinary notifications. The extension keeps the level the push asked for.
 */
function withTimeSensitiveNotifications(config) {
  return withEntitlementsPlist(config, (config) => {
    config.modResults['com.apple.developer.usernotifications.time-sensitive'] =
      true;
    return config;
  });
}

function withExtensionFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const dir = path.join(config.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'NotificationService.swift'), SWIFT);
      fs.writeFileSync(
        path.join(dir, 'Info.plist'),
        extensionInfoPlist(
          config.version ?? '1.0.0',
          config.ios?.buildNumber ?? '1',
          config.extra?.notificationFiltering === true,
        ),
      );
      fs.writeFileSync(
        path.join(dir, `${TARGET}.entitlements`),
        extensionEntitlements(
          config.extra?.apnsEnvironment === 'production'
            ? 'production'
            : 'development',
          config.extra?.notificationFiltering === true,
        ),
      );
      return config;
    },
  ]);
}

function withExtensionTarget(config, { bundleIdentifier }) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    if (project.pbxTargetByName(TARGET)) return config;

    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    // Info.plist and entitlements are referenced by build settings only; as
    // group files they would be copied into the bundle as resources.
    const group = project.addPbxGroup(
      ['NotificationService.swift'],
      TARGET,
      TARGET,
    );
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    const target = project.addTarget(
      TARGET,
      'app_extension',
      TARGET,
      bundleIdentifier,
    );
    project.addBuildPhase(
      ['NotificationService.swift'],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid,
    );
    project.addBuildPhase(
      [],
      'PBXResourcesBuildPhase',
      'Resources',
      target.uuid,
    );
    project.addBuildPhase(
      [],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid,
    );

    const mainSettings = Object.values(
      project.pbxXCBuildConfigurationSection(),
    ).find(
      (entry) =>
        entry?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER &&
        entry.buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', '') ===
          config.ios?.bundleIdentifier,
    )?.buildSettings;

    for (const entry of Object.values(
      project.pbxXCBuildConfigurationSection(),
    )) {
      if (entry?.buildSettings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
      Object.assign(entry.buildSettings, {
        INFOPLIST_FILE: `${TARGET}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        CODE_SIGN_STYLE: 'Automatic',
        IPHONEOS_DEPLOYMENT_TARGET:
          config.ios?.deploymentTarget ??
          mainSettings?.IPHONEOS_DEPLOYMENT_TARGET ??
          '16.4',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '"1,2"',
        GENERATE_INFOPLIST_FILE: 'NO',
        ...(mainSettings?.DEVELOPMENT_TEAM
          ? { DEVELOPMENT_TEAM: mainSettings.DEVELOPMENT_TEAM }
          : {}),
      });
    }
    return config;
  });
}

/** Adds the iOS Notification Service Extension that decrypts Hatch pushes. */
module.exports = function withNotificationServiceExtension(config) {
  const bundleIdentifier = `${config.ios?.bundleIdentifier ?? 'app.hatch.mobile'}.NotificationService`;
  config = withMainAppKeychain(config);
  config = withTimeSensitiveNotifications(config);
  config = withExtensionFiles(config);
  config = withExtensionTarget(config, { bundleIdentifier });
  return config;
};
