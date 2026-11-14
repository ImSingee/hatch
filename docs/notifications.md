# Notification center

Apps and external Channels push notifications to the platform. Users route
them to destinations: signed-in iOS devices, webhooks, and Apps that accept
notifications. Everything is workspace-level, like Apps and dashboards; every
signed-in user can see and change it.

## Model

- **Source**: an App (kinds declared in its manifest), a Channel (kinds
  declared in platform configuration), the platform itself (test sends), or a
  user who sent straight to a group or destination (`user`, below).
- **Destination**: `device` (one mobile sign-in session), `webhook` (URL +
  signing secret), or `app` (an App whose live manifest declares
  `notifications.destination`). The App destination row is created on the
  deploy or rollback cutover that first declares it and is kept when the
  declaration is later dropped, so groups and routes survive; delivery then
  fails with "App no longer accepts notifications".
- **Group**: a set of destinations. A group with `autoAddDevices` gains every
  device destination created afterwards (a phone that turns on push, or signs
  in again and registers a new session). Turning it on does not add existing
  devices, re-registering an existing device never re-adds it after it was
  removed, and webhooks and Apps never join automatically. A full group
  (200 members) is skipped instead of failing the registration.
- **Route**: `(sourceType app|channel|any, sourceId?, kind?) → group | destination`.
  Null source/kind match anything. All matching routes are expanded, then
  deduplicated per destination; each destination gets one delivery recording
  every route that selected it. An App never receives its own notifications.
  Platform and user notifications are never routed: they name their
  recipient, and their deliveries record no routes.
- **Reply form**: an optional form a notification asks people to answer
  (`buttons`, `single`, `multiple` and `text` fields). It takes one answer,
  from whoever answers first, and the answer never changes.
- **Response route**: `(sourceType, sourceId?, kind?) → destination`, where the
  destination is a webhook or an App that accepts responses. Every matching
  response route receives the answer once. An App may receive answers to its
  own notifications.

Code: `src/server/notifications/` (`ingest.ts`, `dispatcher.ts`, `service.ts`,
`adapters/*`, `apns/*`). Tables: `notifications`, `notification_deliveries`,
`notification_destinations`, `notification_groups`,
`notification_group_members`, `notification_routes`, `notification_channels`,
`notification_responses`, `notification_response_routes`,
`notification_response_deliveries` (replies: `responses.ts`).

## Ingress

Both endpoints accept the same JSON body (≤64 KiB):

```json
{
  "kind": "order.shipped",
  "title": "Order 42 shipped",
  "body": "optional, ≤4000",
  "url": "https://optional.example/absolute",
  "autoOpenUrl": "optional boolean; defaults to whether url is set",
  "data": { "optional": "JSON object ≤32 KiB" },
  "dedupeKey": "optional; repeats return the first notification",
  "occurredAt": "optional ISO-8601"
}
```

`url` is any absolute URL a device can open: a web page, another app by its
own scheme (`mailto:`, `tel:`, `slack://…`), since leaving for another app is
intended, or a Hatch deep link: the page's path on the instance after
`hatch://`, such as `hatch://app/<slug>#/orders/42` or
`hatch://agent/<id>`, optionally `?instance=<origin>` for a page on another
instance. Phones open deep links natively; the web opens them on the instance.
Deep links to `/api`, `/cli` or `/login`, with dot segments, or with an
instance that is not a bare HTTPS origin are rejected with `400`, and so are
relative URLs and schemes that only run inside the current document
(`javascript:`, `data:`, `blob:`, `file:`, `about:`). Destinations
receive `url` as written.

`autoOpenUrl` makes tapping the notification on a phone open `url` instead of
the notification's page in the app. It defaults to `true` when `url` is set and
`false` otherwise; `false` keeps the notification page, and `true` without
`url` is rejected. Other destinations receive the flag in their envelope; the web UI shows
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
- **User sends**: `SendNotification` (`hatch notification send`) takes the
  same body and exactly one recipient, authenticated by a user session or API
  key:
  - `channel_id` (`--channel`): as that Channel, without its token. It shares
    the kind check, dedupe scope and routing with token pushes
    (`ingestChannelPush`); `kind` is required. A disabled channel answers
    `CONFLICT`.
  - `group_id` (`--group`) or `destination_id` (`--destination`, any device,
    webhook or App destination): from the caller, never routed. The source is
    `user` with the caller's id and name (`notifications.user_id`, set null
    if the user is deleted; `source_name` keeps the name). A group reaches its
    enabled members, none queues nothing; a destination must be enabled
    (`CONFLICT`). `kind` is a free label, default `message` ("Message"), and
    dedupe keys are scoped to the sending user. Token pushes and Apps cannot
    address recipients this way: choosing them outside routes is reserved to
    users.

  An unset `auto_open_url` takes the same default as `autoOpenUrl`; the CLI
  sends `false` only for `--no-auto-open-url`. Unknown recipients answer
  `NOT_FOUND`, an invalid body or undeclared Channel kind `BAD_REQUEST`, and
  the response carries the queued delivery count so callers can spot sends
  that reached no enabled destination. `NotificationService` reads requests
  up to 128 KiB (twice the Channel push cap) because `data_json` is escaped
  inside the request.

### Edits and recalls

An App or Channel can edit or recall what it sent, under the same
authentication as pushing, and any workspace member can edit or recall any
notification:

- App: `POST /api/app/<id>/notifications/update` and `…/recall` (SDK
  `updateNotification(id, patch)` and `recallNotification(id)`).
- Channel: `POST /api/notifications/channel/<channelId>/update` and `…/recall`.
- Member (session or API key): `NotificationService.UpdateNotification` and
  `RecallNotification` (below).

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
Omitted fields keep their value and `null` clears `body`, `url` or `data`.
Without `autoOpenUrl`, a newly added `url` opens on tap (the push default), a
cleared one stops and a replaced one keeps the setting. `kind`, `dedupeKey` and
`occurredAt` never change. A recall takes only `id`. The id is in the body
because the HMAC covers only the body: a replay can only repeat the same
change. Both respond `200 { id, revision, recalled, changed }`. `400` means an invalid
body or an empty edit. `404` means the notification does not exist or belongs
to another source (the two cases are indistinguishable). `409` means an edit
of a recalled notification. Repeating a recall, or an edit that changes
nothing, leaves the revision as it is, answers `changed: false` and sends
nothing.

Members edit and recall through `NotificationService.UpdateNotification` and
`RecallNotification` (CLI `hatch notification update|recall <id>`), the
counterparts of `SendNotification`, with the same rules. Notification ids are
globally unique, so the id alone names the notification. The platform has no
per-user permissions and members are all equal, so a member may change any
notification, whatever its source (App, Channel, platform or any user) and
whether or not its Channel is enabled. An App or Channel that edits it later
still can, and finds it recalled (`409`) if a member recalled it. In the RPC
an empty `body`, `url` or `data_json` clears the field.

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

### Replies

A push may carry `reply`, a form people answer once:

```json
{
  "kind": "deploy",
  "title": "Deploy v2.4 to production?",
  "reply": {
    "fields": [
      {
        "id": "decision",
        "type": "buttons",
        "label": "Approve the deploy?",
        "options": [
          { "id": "approve", "label": "Approve" },
          { "id": "reject", "label": "Reject", "destructive": true }
        ]
      }
    ],
    "submitLabel": "Send"
  }
}
```

The form has 1-10 fields with unique ids. Every field has `id`, `type` and
`label`, plus optional `description` and `required` (default `true`).

| Type       | Answer         | Rules                                                                                                    |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `buttons`  | one option id  | A single choice shown as buttons: 1-4 options, labels up to 32 characters; options may be `destructive`. |
| `single`   | one option id  | 2-50 options.                                                                                            |
| `multiple` | option id list | 2-50 options, `minSelected` (default 1) to `maxSelected` (default all).                                  |
| `text`     | text           | `placeholder`, `multiline`, `maxLength` (default 1000, at most 4000).                                    |

The rules live in `packages/hatch-platform-api/notification-reply*.ts`, shared
by ingress, the CLI and the mobile app. Empty values (`null`, `""`, `[]`, `0`)
mean "omitted"; settings that do not apply to a field type are rejected. The
stored form is normalized with every default filled in, and a `400` names the
field to fix (`reply.fields.0.options: …`). The form is fixed once sent: edits
cannot change it, and recalling the notification closes it. With a form,
`autoOpenUrl` defaults to `false`, so a phone tap opens the form.

Answers are keyed by field id: `{ "decision": "approve" }`. A `buttons` or
`single` field takes an option id, a `multiple` field a list of option ids, and
a `text` field the trimmed text. Unanswered optional fields are left out.
`respondToNotification` (`responses.ts`) runs in one transaction:

1. It locks the notification. A notification without a form answers `400`, a
   recalled one `409`, and one already answered `409` with the existing answer
   (`ALREADY_RESPONDED`). Concurrent answers serialize on the row lock, and
   `notification_responses` has the notification id as primary key.
2. It stores the answer with the user, a name snapshot, where it was given
   (`via`: `push`, `mobile`, `web`, `cli`) and, from a push, the device. It
   sets `responded_at` and increments the revision, recording the new value
   as `response_revision`.
3. It re-queues only device deliveries, so phones replace the notification
   with its answered state (see the phone section). Webhooks and Apps learn of
   the answer only through response routes: `planDelivery` does not count
   `response_revision` as a change they missed, so a webhook or App delivery
   that was in flight when the answer landed finishes without sending an
   edit event.
4. It queues one `notification_response_deliveries` row per destination that
   matching, enabled response routes select. Like routing, this applies to
   App and Channel notifications only: a member's direct notification (to a
   group or destination) keeps its answer in history.

Answers come from:

- The Web detail page (`respondToNotificationFn`, `via: web`).
- `NotificationService.RespondToNotification` for the mobile app and the CLI
  (`hatch notification respond`). The request names `via` (`mobile` or `cli`,
  default `cli`); it is history only and changes no permission.
- `POST /api/notifications/device-response`, a button or text reply on the
  notification itself. It is described in the phone section.

The dispatcher claims response deliveries from their own table with the same
lease, retry and backoff, and posts `hatch.notification.responded`. These
deliveries are one-shot: they never take revisions. An App destination
receives them only while its live manifest sets
`notifications.destination.responses: true`; the deploy cutover copies the
setting onto `accepts_responses`, and only such Apps (and webhooks) can be
response route targets. When an App later drops the setting, its deliveries
fail with "App no longer accepts responses." Every envelope's `notification`
carries `reply`. Only `hatch.notification.responded` carries `response`:
ordinary notification, edit and recall deliveries to a webhook or App never
include the answer, so a destination receives answers only when a response
route selects it.

```json
{
  "type": "hatch.notification.responded",
  "notification": {
    "id": "…",
    "reply": { "fields": ["…"], "submitLabel": "Submit" },
    "response": {
      "answers": { "decision": "approve" },
      "respondedBy": { "userId": "…", "name": "Ada" },
      "via": "push",
      "respondedAt": "2026-11-15T09:30:00.000Z"
    }
  }
}
```

`notification.data` passes through unchanged, so the sender can correlate the
answer with its own records. The envelope's top-level `revision` is the revision the answer
created (`response_revision`), on every attempt, even if the notification is
edited or recalled before the answer is delivered; `notification` itself shows
the current state. History retention keeps a notification while any delivery
of its answer is pending.

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

`source.type` is `app`, `channel`, `platform` or `user`; `source.id` is the
App, Channel or sending user id (null for platform and deleted users) and
`slug` is set only for Apps.

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
its link. A Hatch page (the instance's own web address or a `hatch://` deep
link) opens in the app, on the sending instance unless the link names another
one, which the app asks before switching to; a deep link never leaves the app.
Any other URL leaves the app through the same external-link policy as web
surfaces, so it needs no session on that instance.
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

### Replies on the phone

The encrypted content carries `q`, how the phone offers the form:

- `b`: the form is one required `buttons` field `f`, with options `a`.
- `t`: the form is one required `text` field `f`, with button title `l` and
  placeholder `p`.
- `f`: any other form; it is answered in the app.
- `x`: already answered; `s` says by whom and what.

The extension registers a category `hatch.reply.<notification id>` for every
`b`, `t` and `f` push before it shows the notification, because action titles
come from the decrypted content. It keeps the newest 64 such categories; ids
are time-ordered. The actions are:

- `b`: one action per option, with `authenticationRequired` (answers are
  final, so nobody answers from a locked phone) and `destructive` where set.
- `t`: a system text reply.
- `f`: "Answer…", which opens the app.

For `x` it adds the summary to the body and sets no category.

Buttons and text replies are sent natively by `HatchReplyDelegate`
(`modules/hatch-push-keys`). That delegate joins expo-notifications'
`NotificationCenterManager`, so it works when iOS wakes only the background,
without the JavaScript runtime or the user's session. Two signatures protect
this path:

- The shared APNs key lets anyone who knows a device token send it a push
  that skips the extension. So the extension signs
  `(origin, notification id, field)` with a key derived from the device key
  (`hatch-reply-tap-v1`), and the delegate sends nothing without that
  signature and a matching category.
- The request carries `x-hatch-kid`, `x-hatch-timestamp` and
  `x-hatch-signature`: an HMAC with another derived key (`hatch-response-v1`)
  over `hatch-response-v1|<timestamp>|<body>`. The platform reads at most
  16 KiB of body and accepts it within five minutes from an enabled device
  whose sign-in session is still live (expired sessions linger until the
  hourly prune) and that received the notification. It records the answer as
  the device owner's (`via: push`).

When the request fails or someone answered first, the phone shows a local
notification saying so. The JavaScript tap handler ignores these actions and
opens the notification for "Answer…". Once answered, the next device delivery
replaces the shown notification passively, without its actions.

## Management API

Web UI: Server Functions in `src/server/notifications.ts`. Native clients and
the CLI: `NotificationService` (`notification.proto`) at `/api/rpc`. Both call
`service.ts`. Session and API-key credentials may manage everything; Run
credentials are rejected (`SESSION_REQUIRED`), so Agents cannot reconfigure
delivery or push through `SendNotification`, and there is intentionally no
Agent tool. `RegisterDevice`,
`UnregisterDevice` and `GetCurrentDevice` require a user session.
`RespondToNotification` answers as the calling user, and response routes have
their own CRUD (`ListResponseRoutes`, `CreateResponseRoute`, …).

## Compatibility

`notifications` is an optional manifest field and capability, so no App
compatibility version or Runner protocol change is needed. Edits and recalls
are additive as well: `destination.lifecycleEvents` is optional. Deployed Apps
that do not set it never receive the new event types, which older SDKs'
`verifyNotificationRequest` would reject. The original envelope only gains
fields. Replies are additive in the same way: Apps receive
`hatch.notification.responded` only with `destination.responses`, webhooks
only through a response route someone creates, and phones without reply
support ignore `q`. Historical
deployments lack the field and neither push nor accept notifications. The
manifest schema is strict, so Platform and Runner must ship the same build.
The `user` source type is an additive envelope value: App destinations built
against the earlier `app | channel | platform` set receive it as a plain
string, so no compatibility version change is needed either.
