import CryptoKit
import ExpoModulesCore
import ExpoNotifications
import Security
import UIKit
import UserNotifications

/// Keychain items readable by the Notification Service Extension. Both targets
/// list the same `keychain-access-groups` entry; its resolved name (with the
/// team prefix) is published in Info.plist as `HatchSharedKeychainGroup`.
enum HatchPushKeychain {
  static let service = "app.hatch.mobile.push-keys"

  static var accessGroup: String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "HatchSharedKeychainGroup") as? String,
          !group.isEmpty, !group.contains("$(") else { return nil }
    return group
  }

  static func baseQuery(kid: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: kid,
    ]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  static func key(kid: String) -> SymmetricKey? {
    var query = baseQuery(kid: kid)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data, data.count == 32 else { return nil }
    return SymmetricKey(data: data)
  }
}

/// Tap fields the Notification Service Extension signs after decrypting a push
/// whose URL opens on tap (`tapSignature` in
/// plugins/with-notification-service-extension.cjs; keep both in sync). Only a
/// holder of this phone's key for the instance can produce the signature.
enum HatchPushTap {
  static func isValid(mac: String, origin: String, id: String, url: String, key: SymmetricKey) -> Bool {
    guard let code = Data(base64Encoded: mac) else { return false }
    let tapKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: key, info: Data("hatch-tap-v1".utf8), outputByteCount: 32)
    let message = "hatch-tap-v1|\(origin.utf8.count)|\(origin)|\(id.utf8.count)|\(id)|\(url.utf8.count)|\(url)"
    return HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Data(message.utf8), using: tapKey)
  }
}

/// Reply fields the Notification Service Extension signs after decrypting a
/// push whose reply form can be answered from the notification
/// (\`replySignature\` in plugins/with-notification-service-extension.cjs; keep
/// both in sync). Answers go only to an origin this phone's key vouched for.
enum HatchReplyTap {
  static func isValid(mac: String, origin: String, id: String, field: String, key: SymmetricKey) -> Bool {
    guard let code = Data(base64Encoded: mac) else { return false }
    let replyKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: key, info: Data("hatch-reply-tap-v1".utf8), outputByteCount: 32)
    let message = "hatch-reply-tap-v1|\(origin.utf8.count)|\(origin)|\(id.utf8.count)|\(id)|\(field.utf8.count)|\(field)"
    return HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Data(message.utf8), using: replyKey)
  }

  /// Signature the platform checks (\`deviceResponseSignature\` in
  /// src/server/notifications/responses.ts).
  static func requestSignature(timestamp: String, body: Data, key: SymmetricKey) -> String {
    let requestKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: key, info: Data("hatch-response-v1".utf8), outputByteCount: 32)
    var message = Data("hatch-response-v1|\(timestamp)|".utf8)
    message.append(body)
    return Data(HMAC<SHA256>.authenticationCode(for: message, using: requestKey)).base64EncodedString()
  }
}

/// Answers a notification's reply form from the notification itself: a tapped
/// button or the system text reply. The app may only be woken in the
/// background, so the answer is sent from here, signed with this phone's push
/// key, without the JavaScript runtime or the user's session.
final class HatchReplyDelegate: NotificationDelegate {
  static let shared = HatchReplyDelegate()
  static let optionPrefix = "hatch.reply.option."
  static let textAction = "hatch.reply.text"
  static let categoryPrefix = "hatch.reply."

  /// `completionHandler` is deliberately not called here: expo-notifications'
  /// `NotificationCenterManager` calls the system's handler itself, right
  /// after every delegate returns (and its JS emitter calls it too), so a call
  /// here would complete the response twice, and it cannot be held until the
  /// request ends. A background task keeps the app alive for the request.
  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let action = response.actionIdentifier
    let isOption = action.hasPrefix(Self.optionPrefix)
    guard isOption || action == Self.textAction else { return false }
    let content = response.notification.request.content
    guard let data = content.userInfo["body"] as? [String: Any],
          let origin = data["hatchOrigin"] as? String,
          let id = data["hatchNotificationId"] as? String,
          let field = data["hatchReplyField"] as? String,
          let kid = data["hatchKid"] as? String,
          let mac = data["hatchReplyMac"] as? String,
          content.categoryIdentifier == Self.categoryPrefix + id,
          let key = HatchPushKeychain.key(kid: kid),
          HatchReplyTap.isValid(mac: mac, origin: origin, id: id, field: field, key: key),
          let base = URL(string: origin), ["https", "http"].contains(base.scheme ?? "")
    else {
      // A reply action without this phone's signature: never send it, and
      // never let it count as a tap either.
      return true
    }
    let value = isOption
      ? String(action.dropFirst(Self.optionPrefix.count))
      : (response as? UNTextInputNotificationResponse)?.userText ?? ""
    send(
      origin: base, id: id, kid: kid, key: key,
      answers: [field: value], thread: content.threadIdentifier)
    return true
  }

  private func send(
    origin: URL, id: String, kid: String, key: SymmetricKey,
    answers: [String: String], thread: String
  ) {
    guard let body = try? JSONSerialization.data(
      withJSONObject: ["notificationId": id, "answers": answers], options: [.sortedKeys])
    else { return }
    let timestamp = String(Int64(Date().timeIntervalSince1970 * 1000))
    var request = URLRequest(url: origin.appendingPathComponent("api/notifications/device-response"))
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(kid, forHTTPHeaderField: "x-hatch-kid")
    request.setValue(timestamp, forHTTPHeaderField: "x-hatch-timestamp")
    request.setValue(
      HatchReplyTap.requestSignature(timestamp: timestamp, body: body, key: key),
      forHTTPHeaderField: "x-hatch-signature")
    request.httpBody = body

    // expo-notifications has already completed the response, so the system
    // may suspend the app at any moment; a background task finishes the
    // request first.
    var task = UIBackgroundTaskIdentifier.invalid
    let end = {
      if task != .invalid {
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
      }
    }
    DispatchQueue.main.async {
      task = UIApplication.shared.beginBackgroundTask(withName: "hatch.reply", expirationHandler: end)
      URLSession.shared.dataTask(with: request) { data, response, error in
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 {
          Self.reportFailure(
            id: id, origin: origin.absoluteString, thread: thread, status: status,
            message: Self.errorMessage(data) ?? error?.localizedDescription)
        }
        DispatchQueue.main.async(execute: end)
      }.resume()
    }
  }

  private static func errorMessage(_ data: Data?) -> String? {
    guard let data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let error = json["error"] as? [String: Any]
    else { return nil }
    return error["message"] as? String
  }

  /// The answer did not count: say why on the notification, which opens the
  /// form in the app when tapped.
  private static func reportFailure(id: String, origin: String, thread: String, status: Int, message: String?) {
    let content = UNMutableNotificationContent()
    content.title = status == 409 ? "Answer not needed" : "Answer not sent"
    content.body = message ?? "Open the notification to answer it."
    content.threadIdentifier = thread
    content.userInfo = ["body": ["hatchNotificationId": id, "hatchOrigin": origin]]
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: "\(id).reply-failed", content: content, trigger: nil))
  }
}

final class HatchPushKeyException: GenericException<OSStatus> {
  override var reason: String { "Keychain operation failed (\(param))." }
}

final class HatchPushKeyFormatException: Exception {
  override var reason: String { "Push key must be 32 bytes of base64url." }
}

public final class HatchPushKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HatchPushKeys")

    OnCreate {
      NotificationCenterManager.shared.addDelegate(HatchReplyDelegate.shared)
    }

    OnDestroy {
      NotificationCenterManager.shared.removeDelegate(HatchReplyDelegate.shared)
    }

    AsyncFunction("setKey") { (kid: String, keyBase64url: String) in
      guard let data = Self.decodeBase64url(keyBase64url), data.count == 32 else {
        throw HatchPushKeyFormatException()
      }
      let query = HatchPushKeychain.baseQuery(kid: kid)
      SecItemDelete(query as CFDictionary)
      var item = query
      item[kSecValueData as String] = data
      // Pushes usually arrive while the phone is locked.
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let status = SecItemAdd(item as CFDictionary, nil)
      guard status == errSecSuccess else { throw HatchPushKeyException(status) }
    }

    AsyncFunction("deleteKey") { (kid: String) in
      let status = SecItemDelete(HatchPushKeychain.baseQuery(kid: kid) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw HatchPushKeyException(status)
      }
    }

    AsyncFunction("hasKey") { (kid: String) -> Bool in
      var query = HatchPushKeychain.baseQuery(kid: kid)
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    AsyncFunction("verifyTap") {
      (kid: String, mac: String, origin: String, id: String, url: String) -> Bool in
      guard let key = HatchPushKeychain.key(kid: kid) else { return false }
      return HatchPushTap.isValid(mac: mac, origin: origin, id: id, url: url, key: key)
    }
  }

  private static func decodeBase64url(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    return Data(base64Encoded: base64)
  }
}
