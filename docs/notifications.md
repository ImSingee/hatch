# Notification center

Apps and external Channels push notifications to the platform. Users route
them to destinations: signed-in iOS devices, webhooks, and Apps that accept
notifications. Everything is workspace-level, like Apps and dashboards; every
signed-in user can see and change it.

## Model

- **Source**: an App (kinds declared in its manifest), a Channel (kinds
  declared in platform configuration), or the platform itself (test sends).
- **Destination**: `device` (one mobile sign-in session), `webhook` (URL +
  signing secret), or `app` (an App whose live manifest declares
  `notifications.destination`). The App destination row is created on the
  deploy or rollback cutover that first declares it and is kept when the
  declaration is later dropped, so groups and routes survive; delivery then
  fails with "App no longer accepts notifications".
- **Group**: a set of destinations.
- **Route**: `(sourceType app|channel|any, sourceId?, kind?) → group | destination`.
  Null source/kind match anything. All matching routes are expanded, then
  deduplicated per destination; each destination gets one delivery recording
  every route that selected it. An App never receives its own notifications.

Code: `src/server/notifications/` (`ingest.ts`, `dispatcher.ts`, `service.ts`,
`adapters/*`, `apns/*`). Tables: `notifications`, `notification_deliveries`,
`notification_destinations`, `notification_groups`,
`notification_group_members`, `notification_routes`, `notification_channels`.

## Ingress

Both endpoints accept the same JSON body (≤64 KiB):

```json
{
  "kind": "order.shipped",
  "title": "Order 42 shipped",
  "body": "optional, ≤4000",
  "url": "https://optional.example/absolute",
  "autoOpenUrl": false,
  "data": { "optional": "JSON object ≤32 KiB" },
  "dedupeKey": "optional; repeats return the first notification",
  "occurredAt": "optional ISO-8601"
}
```

`autoOpenUrl` (optional, default `false`, requires `url`) makes tapping the
notification on a phone open `url` instead of the notification's page in the
app. Other destinations receive the flag in their envelope; the web UI shows
it on the notification detail.

Responses: `202 { id, deduplicated }`, `400` invalid body, `413` too large,
`422` undeclared kind.

- **App**: `POST /api/app/<id>/notifications`, HMAC with the App signing
  secret over `<timestamp>.<raw body>` (`x-hatch-timestamp`,
  `x-hatch-signature`), like KV. Requires a live, non-archived deployment
  with `notifications` and `backend`. The SDK `notify()` in
  `@hatch/app/notifications` uses the injected `HATCH_NOTIFICATIONS_URL`.
- **Channel**: `POST /api/notifications/channel/<channelId>` with the channel
  token in `x-hatch-secret` (header presence wins, even empty) or `?secret=`.
  Only the token's sha256 is stored; create and rotate return it once.
  Disabled channels answer 403.

### Edits and recalls

The source of a notification can edit or recall it, under the same
authentication as pushing:

- App: `POST /api/app/<id>/notifications/update` and `…/recall` (SDK
  `updateNotification(id, patch)` and `recallNotification(id)`).
- Channel: `POST /api/notifications/channel/<channelId>/update` and `…/recall`.

```json
{
  "id": "<notification id>",
  "title": "…",
  "body": null,
  "url": null,
  "autoOpenUrl": false,
  "data": null
}
```

An edit changes any of `title`, `body`, `url`, `autoOpenUrl` and `data`.
Omitted fields keep their value, `null` clears `body`, `url` or `data`, and
clearing `url` also turns `autoOpenUrl` off. `kind`, `dedupeKey` and
`occurredAt` never change. A recall takes only `id`. The id is in the body
because the HMAC covers only the body: a replay can only repeat the same
change. Both respond `200 { id, revision, recalled }`. `400` means an invalid
body or an empty edit. `404` means the notification does not exist or belongs
to another source (the two cases are indistinguishable). `409` means an edit
of a recalled notification. Repeating a recall, or an edit that changes
nothing, leaves the revision as it is and sends nothing.

Every edit and the recall increment `notifications.revision`, which starts at

1. Each delivery records `delivered_revision`, the revision its destination
   last received (`lifecycle.ts`, `dispatcher.ts`):

- In the same transaction, a change re-queues every delivery that already
  delivered something, as long as its destination is enabled and takes
  lifecycle events. Each such delivery gets a fresh attempt series.
- Deliveries that never delivered behave differently. A recall cancels them
  (`canceled`, shown as "Not sent"), so recalled content never goes out. After
  an edit, a pending delivery simply sends the newest content as the original
  notification.
- `planDelivery` picks the event from `delivered_revision`:
  `hatch.notification` when nothing was delivered yet, otherwise
  `hatch.notification.updated` or `hatch.notification.recalled`. Edits made
  before the dispatcher runs collapse into one event for the latest state.
- `recordOutcome` share-locks the notification row before it writes. An
  attempt that sent an older revision than the current one goes back to
  `pending` instead of finishing, so a change that lands while a delivery is
  in flight is sent right after it. Events to one destination never overtake
  each other, because they share one delivery row and its lease.

Devices always take lifecycle events. Webhooks take them when "Also send edits
and recalls" is on (`lifecycle_events`, off by default, because a receiver
written for the original envelope would treat an edit as a new notification).
Apps take them when the live manifest sets
`notifications.destination.lifecycleEvents: true`; the deploy cutover copies
that setting onto the destination. History keeps the latest content plus
`editedAt` and `recalledAt`. The Web, mobile and CLI history mark notifications
as edited or recalled.

## Delivery

Ingest writes the notification and its deliveries in one transaction and
wakes the in-process dispatcher (`ensureNotificationDispatcher`, started by
the Nitro startup plugin; it also polls every 5 s).

- Claims use `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` with a
  2-minute lease, so concurrent workers never share an attempt and a crashed
  worker's rows become claimable when the lease expires. Outcomes are written
  only while the claimed attempt still owns the row.
- Up to 6 attempts with backoff 30 s, 2 min, 10 min, 1 h, 6 h. Network errors,
  timeouts, 5xx, 408 and 429 retry; other statuses fail. Failed deliveries can
  be retried manually (Web UI, `hatch notification retry`, `RetryDelivery`).
- Notifications are retained 90 days (deliveries cascade); rows with
  in-flight deliveries are never pruned.

Webhook and App destinations receive the same envelope:

```json
{
  "type": "hatch.notification",
  "version": 1,
  "deliveryId": "…",
  "attempt": 1,
  "revision": 1,
  "notification": {
    "id": "…",
    "kind": "…",
    "kindName": "…",
    "title": "…",
    "body": null,
    "url": null,
    "autoOpenUrl": false,
    "data": null,
    "dedupeKey": null,
    "occurredAt": "…",
    "revision": 1,
    "editedAt": null,
    "recalledAt": null,
    "createdAt": "…",
    "source": { "type": "app", "id": "…", "slug": "…", "name": "…" }
  }
}
```

`type` is `hatch.notification.updated` or `hatch.notification.recalled` for an
edit or a recall. Those envelopes carry the notification's current state.
`(notification.id, revision)` identifies one event.

Headers: `x-hatch-event` (the envelope `type`), `x-hatch-notification-id`, `x-hatch-delivery-id`,
`x-hatch-timestamp`, `x-hatch-signature` (`sha256=<hex HMAC(timestamp + "." + body)>`).

- **Webhook**: signed with the webhook's own secret (envelope-encrypted at
  rest because signing needs it; shown once on create/rotate). 10 s timeout,
  redirects are not followed, only the first 4 KiB of an error body is kept.
  Private and Tailscale addresses are allowed on purpose: the platform is
  self-hosted and URLs are configured by trusted workspace members.
- **App**: `POST /__notification` on the App backend via `callAppBackend`,
  signed with the App signing secret, 30 s timeout. A JSON `{ "result": string }`
  or `text/plain` response body is stored verbatim (≤2000 characters) as the
  delivery result; the platform never interprets it.
- **Device**: APNs, below.

## iOS push without a relay

Every self-hosted instance pushes directly to APNs over HTTP/2 with token
authentication (`apns/client.ts`, Node built-ins only), as Bark does. The
official app's credentials ship in `apns/shared-credentials.ts`: Apple
_topic-specific_ keys restricted to `app.hatch.mobile`, one per environment.
`HATCH_APNS_TEAM_ID`, `HATCH_APNS_TOPIC` and
`HATCH_APNS_{PRODUCTION,SANDBOX}_{KEY_ID,PRIVATE_KEY}` replace them as a whole
for instances that ship their own iOS build. Settings shows which source is in
use and the last credential error.

What the shared key does and does not protect:

- The key can only push to the Hatch app (topic-specific), not other apps of
  the team.
- Pushing needs a device token. Tokens reach only the instances the device
  enabled push on (session-only `RegisterDevice`) and are never shown in UI,
  CLI or logs.
- Content sent by Hatch is end-to-end encrypted. At registration the device
  generates a 32-byte key per instance and sends it with its token over TLS;
  the instance stores it envelope-encrypted. Pushes carry only a placeholder
  alert plus `h: { v: 1, kid, c }` where `c` is AES-256-GCM in CryptoKit
  combined layout (nonce ‖ ciphertext ‖ tag) with AAD `hatch-push-v1|<kid>`,
  and set `mutable-content: 1` so the Notification Service Extension decrypts
  it. Apple sees no notification text from Hatch.
- The extension only authenticates pushes that invoke it. A push marked
  `mutable-content` that it cannot decrypt is shown as coming from an
  unverified source, without sender text. iOS runs the extension only when the
  sender sets `mutable-content: 1`, so this check is advisory, not a boundary.
- **Residual risk (accepted):** anyone who holds a device token can use the
  published key to show arbitrary alert text in the Hatch app on that device,
  by omitting `mutable-content`. Token holders are the instances where push
  was enabled, including an instance whose operator kept the token after the
  device signed out. Enable push only on instances you trust. Enforcing the
  encrypted format would require a trusted relay that holds the key; that is
  deliberately out of scope (no Expo push service, no hosted relay).

APNs responses: 410 / `BadDeviceToken` / `Unregistered` /
`DeviceTokenNotForTopic` fail the delivery and disable the device; credential
errors (403, `InvalidProviderToken`, …) fail without disabling and record the
error on the destination; 429 and 5xx retry. Bodies are shortened to keep the
payload within 4 KiB, then the URL is dropped, then the title is shortened;
the full text stays in the app's notification detail. When the URL opens on
tap (`ao: true` in the encrypted content), the title is shortened before the
URL is dropped, and dropping the URL always drops `ao`.

Opening the URL on tap is gated on the extension. A push that bypasses it (no
`mutable-content`, see the residual risk above) can write any tap data, so the
extension signs the fields it decrypted, `HMAC-SHA256` over
`hatch-tap-v1|<len>|<origin>|<len>|<id>|<len>|<url>` with a key derived by
HKDF-SHA256 (`info = hatch-tap-v1`) from the device key. The app opens the URL
only when its native key module verifies that signature with this phone's key
for that instance; otherwise the tap opens the notification, which still shows
its link. Only the URL leaves the app, through the same external-link policy as
web surfaces, so it needs no session on that instance.
Device rows reference their sign-in session with `ON DELETE CASCADE`, so
signing out or revoking the session removes the device. Better Auth deletes an
expired session only when it is presented again, which a replaced or wiped
phone never does, so the platform removes a device whose session has expired
itself: a delivery to it fails without contacting APNs and removes the device,
and an hourly sweep removes the ones nothing is delivered to. APNs is not
relied on for this; it may keep accepting pushes for a device that is simply
never online again instead of answering `Unregistered`.

The name a phone sends with `RegisterDevice` only names a new device row; the
app re-registers on every launch and token change without touching the name,
so a rename from the app, the Web UI or `hatch notification destination
rename` sticks. The app's default is the user-assigned device name when iOS
exposes it (that needs the managed
`com.apple.developer.device-information.user-assigned-device-name`
entitlement, which the app does not hold), otherwise the model name such as
"iPhone 17 Pro".

A device records why it is disabled (`disabled_reason`), which decides who may
turn it back on:

- `user`: disabled in settings. The app's automatic re-registration (launch,
  token rotation) keeps it disabled; only settings re-enable it.
- `device`: push turned off in the app (`UnregisterDevice`). The phone drops
  its key, so settings cannot re-enable it; turning push on in the app
  re-registers the same destination with its routes and groups intact.
- `unregistered`: APNs rejected the token. It revives when the phone registers
  a different token. The rejection only disables the device if it still holds
  the token that was rejected.

### Edits and recalls on the phone

An edit or recall push reuses the notification id as `apns-collapse-id`,
which iOS uses as the request identifier, so it replaces the notification
already shown. The `aps` of these pushes has no `sound` and sets
`interruption-level: passive`, so they never alert again. The encrypted
content carries `r` (revision) and `e` (`u` for an edit, `r` for a recall). A
recall's content is only "Notification recalled", without the original title,
body or link. App builds that predate edits ignore the new fields and still
replace the notification quietly.

The extension tags its content with `hatchRevision` and `hatchEvent`.

- **Builds without the filtering entitlement (default):** a recall leaves a
  silent "Notification recalled" placeholder. The app removes those
  placeholders when it opens, and removes the recalled notification directly
  when the recall arrives while the app is in the foreground. An edit appears
  in Notification Center without a banner.
- **Builds with the entitlement:** set `HATCH_NOTIFICATION_FILTERING=1`. The
  build then adds `com.apple.developer.usernotifications.filtering` to the
  extension and sets `HatchNotificationFiltering` in its Info.plist. Apple must
  approve that entitlement for the team, otherwise signing fails. In these
  builds the extension removes the recalled notification and suppresses the
  recall push itself. It also suppresses an edit when the original is no
  longer shown, or when the shown copy is already the same or a newer
  revision.

## Management API

Web UI: Server Functions in `src/server/notifications.ts`. Native clients and
the CLI: `NotificationService` (`notification.proto`) at `/api/rpc`. Both call
`service.ts`. Session and API-key credentials may manage everything; Run
credentials are rejected (`SESSION_REQUIRED`), so Agents cannot reconfigure
delivery and there is intentionally no Agent tool. `RegisterDevice`,
`UnregisterDevice` and `GetCurrentDevice` require a user session.

## Compatibility

`notifications` is an optional manifest field and capability, so no App
compatibility version or Runner protocol change is needed. Edits and recalls
are additive as well: `destination.lifecycleEvents` is optional. Deployed Apps
that do not set it never receive the new event types, which older SDKs'
`verifyNotificationRequest` would reject. The original envelope only gains
fields. Historical
deployments lack the field and neither push nor accept notifications. The
manifest schema is strict, so Platform and Runner must ship the same build.
