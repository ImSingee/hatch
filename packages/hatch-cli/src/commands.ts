export type CliCommandDefinition = {
  path: readonly string[];
  usage: string;
  description: string;
};

/** Global options accepted by the CLI. */
export const globalOptions = [
  '--json',
  '--profile <name>',
  '--config <path>',
  '--workdir <path>',
  '--timeout <seconds>',
  '--help',
  '--version',
] as const;

const definitions: readonly CliCommandDefinition[] = [
  {
    path: ['help'],
    usage: 'help [command]',
    description: 'Show command help.',
  },
  {
    path: ['version'],
    usage: 'version',
    description: 'Show the CLI version.',
  },
  {
    path: ['auth', 'login'],
    usage: 'auth login [--url <url>] [--no-browser | --api-key-file <path>]',
    description: 'Save a browser-approved session credential.',
  },
  {
    path: ['auth', 'status'],
    usage: 'auth status',
    description: 'Inspect the current credential and identity.',
  },
  {
    path: ['auth', 'logout'],
    usage: 'auth logout [--local-only]',
    description: 'Revoke and remove the selected local login credential.',
  },
  ...(['app', 'workflow'] as const).flatMap((resource) => [
    {
      path: [resource, 'list'],
      usage: `${resource} list`,
      description: `List ${resource} resources.`,
    },
    {
      path: [resource, 'get'],
      usage: `${resource} get <id>`,
      description: `Inspect a ${resource}.`,
    },
    {
      path: [resource, 'create'],
      usage: `${resource} create --file <path|-> [--directory <path>]`,
      description: `Create a ${resource} and its local checkout.`,
    },
    {
      path: [resource, 'clone'],
      usage: `${resource} clone <id> [--directory <path>] [--force]`,
      description: `Clone ${resource} source over Git into a local checkout whose origin is the platform remote. --force replaces the directory.`,
    },
    {
      path: [resource, 'update'],
      usage: `${resource} update [--directory <path>]`,
      description: `Fetch platform master into origin/master and fast-forward the ${resource} checkout. Local commits are preserved; a checkout that is only ahead reports state "ahead".`,
    },
    {
      path: [resource, 'push'],
      usage: `${resource} push [--directory <path>]`,
      description: `Push the checkout's HEAD to platform master without deploying. Fast-forward only; a rejected push exits with non_fast_forward. Uncommitted changes are not pushed.`,
    },
    {
      path: [resource, 'deploy'],
      usage: `${resource} deploy [--directory <path>] [--message <text>] [--commit <sha>] [--allow-destructive-data-migration --data-migration-approval-token <token>] [--reconcile | --retry-after-confirming <commit>]`,
      description: `Push HEAD to platform master, then release it. --commit <sha> skips the push and releases that full commit id, which must already be on platform master.`,
    },
    {
      path: [resource, 'rollback'],
      usage: `${resource} rollback <id> --version <number>`,
      description: `Activate a previous ${resource} deployment.`,
    },
  ]),
  {
    path: ['git-credential'],
    usage: 'git-credential <get|store|erase>',
    description:
      'Git credential helper for checkouts created by this CLI; git runs it, not people. get reads a request on stdin and prints the current credential to stdout as the password, only for the logged-in platform URL. store and erase do nothing.',
  },
  ...(['app', 'workflow'] as const).map((resource) => ({
    path: [resource, 'adopt'],
    usage: `${resource} adopt <id> --directory <path>`,
    description:
      'Attach a verified Agent checkout without discarding source or history.',
  })),
  {
    path: ['app', 'invoke', 'webhook'],
    usage:
      'app invoke webhook <id-or-slug> [--path <relative-suffix>] [--method <HTTP-method>] [--file <path|->] [--content-type <type>] [--header <Name:value>] [--query <name=value>] [--json]',
    description:
      'Call the existing App hook URL once with profile/env credentials. Default POST, empty body, application/octet-stream; --file sends exact bytes. GET/HEAD reject --file. Repeat --header for App-owned headers and --query for encoded query values. Authorization/x-api-key are stripped before App code and cannot carry private auth. Raw response bytes go to stdout (redirect to a file); --json returns ok/status/contentType/bodyEncoding=base64/body. Non-2xx exits nonzero; no retries or redirects.',
  },
  {
    path: ['app', 'associate'],
    usage: 'app associate <id>',
    description:
      'Associate with the verified current Run session, or report not-applicable.',
  },
  {
    path: ['app', 'invoke', 'backend'],
    usage:
      'app invoke backend <id-or-slug> <package.Service/Method> [--file <path|->]',
    description:
      'Invoke an App backend using Connect unary JSON (default request: {}). No streaming or native gRPC.',
  },
  {
    path: ['app', 'backend', 'list'],
    usage: 'app backend list [--limit <1-100>] [--cursor <id>] [--json]',
    description:
      'List runnable App backends in App id order, 50 per page by default; pass the printed nextCursor as --cursor for the next page (nextCursor is null on the last one). Each entry carries its runtime state: id, slug, mode (serverless or long-running), state (running, starting or stopped), pid, keep-alive mark and the number of draining instances. Runtime facts describe the answering platform process and are not persisted.',
  },
  {
    path: ['app', 'backend', 'status'],
    usage: 'app backend status <id-or-slug> [--json]',
    description:
      'Show one App backend. drainingInstances counts retired instances that still finish in-flight requests after a deploy, rollback or stop; they receive no new requests and exit on their own. lastError holds the most recent start failure.',
  },
  {
    path: ['app', 'backend', 'start'],
    usage: 'app backend start <id-or-slug> [--json]',
    description:
      'Start the backend of the active deployment and wait until it is reachable. A long-running backend is marked keep-alive, so the platform restarts it after an unexpected exit. No-op when already running.',
  },
  {
    path: ['app', 'backend', 'stop'],
    usage: 'app backend stop <id-or-slug> [--force] [--json]',
    description:
      'Stop the backend gracefully and clear its keep-alive mark: no instance receives another request, and each is sent SIGTERM (then SIGKILL 5 seconds later) once its in-flight requests finish or the platform drain timeout elapses. A serverless backend starts again on the next request. --force kills every instance at once, draining ones included, and fails their in-flight requests. Idempotent.',
  },
  {
    path: ['app', 'backend', 'restart'],
    usage: 'app backend restart <id-or-slug> [--force] [--json]',
    description:
      'Start a fresh instance and retire the previous one, which finishes its in-flight requests beside the new instance. --force kills the previous instance instead and fails its in-flight requests.',
  },
  {
    path: ['app', 'kv', 'list'],
    usage:
      'app kv list <app-id> [--cursor <key>] [--limit <count>] [--reveal-secrets]',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'kv', 'get'],
    usage: 'app kv get <app-id> <key> [--reveal-secrets]',
    description: 'Read an App KV entry.',
  },
  {
    path: ['app', 'kv', 'set'],
    usage: 'app kv set <app-id> <key> --file <path|-> [--secret | --no-secret]',
    description: 'Write an App KV entry.',
  },
  {
    path: ['app', 'kv', 'delete'],
    usage: 'app kv delete <app-id> <key>',
    description: 'Delete an App KV entry.',
  },
  {
    path: ['app', 'data-table', 'inspect'],
    usage: 'app data-table inspect <app-id> [--table <name>]',
    description: 'Inspect App Data Table metadata.',
  },
  {
    path: ['app', 'data-table', 'query'],
    usage: 'app data-table query <app-id> --file <path|->',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'data-table', 'mutate'],
    usage: 'app data-table mutate <app-id> --file <path|->',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'data-table', 'sql'],
    usage:
      'app data-table sql <app-id> --file <path|-> [--statement-timeout-ms <ms>]',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'db', 'query'],
    usage: 'app db query <app-id> --file <path|->',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'icon', 'get'],
    usage: 'app icon get <id-or-slug>',
    description:
      'Show the App icon: key, authenticated path and stored sizes; all null/empty while the App shows its monogram.',
  },
  {
    path: ['app', 'icon', 'set'],
    usage: 'app icon set <id-or-slug> (--file <path|-> | --candidate <id>)',
    description:
      'Replace the App icon with a PNG, JPEG or WebP file (at most 4 MB, sides 64 to 4096 px) or with a candidate from image generate. The platform crops to a centred square and re-encodes it; the previous icon is deleted.',
  },
  {
    path: ['app', 'icon', 'clear'],
    usage: 'app icon clear <id-or-slug>',
    description:
      'Delete the App icon so the App shows its monogram again. Succeeds when there is none.',
  },
  {
    path: ['image-model', 'get'],
    usage: 'image-model get',
    description:
      'Show the selected image model (null when none) and every provider that can generate images with suggested model ids. Never prints API keys.',
  },
  {
    path: ['image-model', 'set'],
    usage: 'image-model set --provider <provider-id> --model <model-id>',
    description:
      'Select the instance image model, replacing the previous choice. The provider must be one listed by image-model get; its existing API key is used.',
  },
  {
    path: ['image-model', 'clear'],
    usage: 'image-model clear',
    description: 'Unselect the image model; image generate then fails.',
  },
  {
    path: ['image', 'generate'],
    usage:
      'image generate (--prompt <text> | --prompt-file <path|->) [--count <1-4>] [--quality low|medium|high] [--glyph-tile <#RRGGBB>] [--output-dir <path>]',
    description:
      'Generate 1024px square images with the selected image model; costs provider credit, limited to 30 images per hour. Prints each candidate id and authenticated path; candidates expire after one day. --glyph-tile expects a white glyph on black and lays it on a solid 512px tile of that colour. --output-dir also saves <id>.png files. Default quality low, default timeout 300 seconds.',
  },
  {
    path: ['theme', 'get'],
    usage: 'theme get',
    description:
      'Show the instance theme: the chosen accent, the default accent and every accent that can be chosen with its #RRGGBB colour.',
  },
  {
    path: ['theme', 'set'],
    usage: 'theme set --accent <name>',
    description:
      'Choose the accent colour of the whole instance, replacing the previous choice. Every signed-in web, mobile and desktop client recolours without a reload. Names come from theme get.',
  },
  {
    path: ['pin', 'list'],
    usage: 'pin list [--limit <n>] [--cursor <cursor>]',
    description:
      'List navigation pins: App pins in order (pin id, App id and slug, label, entry point, App status), pinned Workflows and pinned dashboards. Without --limit it prints every pin. --limit (1-100) pages one sequence: App pins, then Workflows, then dashboards; pass the printed nextCursor as --cursor for the next page. No nextCursor means the last page.',
  },
  {
    path: ['pin', 'add'],
    usage:
      'pin add (--app <id-or-slug> [--label <text>] [--entry <fragment>] [--if-absent] | --workflow <id-or-slug> | --dashboard <id>)',
    description:
      'Pin an App, Workflow or dashboard. --app always adds another pin (an App can have several, each with its own label and entry fragment such as /settings) and prints its pin id; --if-absent instead returns the existing pin when the App already has one. The label defaults to the App name. Pinning a Workflow or dashboard that is already pinned succeeds.',
  },
  {
    path: ['pin', 'update'],
    usage:
      'pin update <pin-id> [--label <text>] [--entry <fragment> | --clear-entry]',
    description:
      'Change an App pin. Omitted fields stay unchanged; --clear-entry makes the pin open the App root.',
  },
  {
    path: ['pin', 'remove'],
    usage:
      'pin remove (--pin <pin-id> | --app <id-or-slug> | --workflow <id-or-slug> | --dashboard <id>)',
    description:
      'Unpin. --pin deletes that one App pin; --app deletes every pin of the App and prints the removed pin ids. --workflow and --dashboard clear the pinned flag; the Workflow or dashboard itself is kept.',
  },
  {
    path: ['pin', 'reorder'],
    usage: 'pin reorder (--pin <pin-id>... | --dashboard <id>...)',
    description:
      'Reorder App pins or dashboards. Repeat the flag in the new order; listed items move to the front and unlisted ones keep their relative order after them. Prints the complete new order. Pinned Workflows are ordered by last update and cannot be reordered.',
  },
  {
    path: ['dashboard', 'list'],
    usage: 'dashboard list [--limit <n>] [--cursor <cursor>]',
    description:
      'Without --limit, list every dashboard in order: id, name, description, pinned and autoRefreshSeconds (0 is off). Pin, unpin and reorder dashboards with pin add --dashboard, pin remove --dashboard and pin reorder --dashboard. --limit (1-100) prints one page and a nextCursor to pass as --cursor; no nextCursor means the last page.',
  },
  {
    path: ['dashboard', 'get'],
    usage: 'dashboard get <dashboard-id>',
    description:
      'Show one dashboard: its settings, the widgets placed on it (id is the placement id that widget layout and widget remove take; supportedSizes lists the only footprints the widget accepts, empty means any) and their x, y, w, h in grid units at each breakpoint (desktop 12 columns, tablet 8, mobile 4).',
  },
  {
    path: ['dashboard', 'create'],
    usage: 'dashboard create --name <text> [--description <text>]',
    description:
      'Create an empty dashboard and print its id. It is pinned and placed last.',
  },
  {
    path: ['dashboard', 'update'],
    usage:
      'dashboard update <dashboard-id> [--name <text>] [--description <text> | --clear-description] [--auto-refresh <1-3600> | --no-auto-refresh]',
    description:
      'Rename a dashboard, change its description or set how often, in seconds, its widgets refresh on an open desk. Omitted fields stay unchanged.',
  },
  {
    path: ['dashboard', 'delete'],
    usage: 'dashboard delete <dashboard-id> --yes',
    description:
      'Permanently delete a dashboard and its widget placements; cannot be undone, so --yes is required. Apps and their widgets are kept. The last dashboard cannot be deleted.',
  },
  {
    path: ['dashboard', 'widget', 'available'],
    usage: 'dashboard widget available [--limit <n>] [--cursor <cursor>]',
    description:
      'List the widgets deployed Apps offer: appId, appSlug, widgetId, name, defaultSize and supportedSizes. Without --limit it prints every widget; --limit (1-100) prints one page and a nextCursor to pass as --cursor; no nextCursor means the last page.',
  },
  {
    path: ['dashboard', 'widget', 'add'],
    usage:
      'dashboard widget add <dashboard-id> --app <id-or-slug> --widget <widget-id> [--breakpoint desktop|tablet|mobile] [--x <n>] [--y <n>] [--w <n>] [--h <n>]',
    description:
      'Place a widget on a dashboard and print its placementId with the new layouts. Without position flags it goes below the others at its default size. Position flags apply to one breakpoint (desktop unless --breakpoint is given) and the other breakpoints follow. A widget can be on a dashboard once.',
  },
  {
    path: ['dashboard', 'widget', 'layout'],
    usage:
      'dashboard widget layout <dashboard-id> <placement-id> [--breakpoint desktop|tablet|mobile] [--x <n>] [--y <n>] [--w <n>] [--h <n>]',
    description:
      'Move a placed widget (--x, --y) or resize it (--w, --h) at one breakpoint, desktop unless --breakpoint is given; omitted numbers stay unchanged. Widgets under the new position move down and empty rows close up, so read the printed layouts for the result. A size the widget does not support is rejected with the sizes it does.',
  },
  {
    path: ['dashboard', 'widget', 'remove'],
    usage: 'dashboard widget remove <dashboard-id> <placement-id>',
    description:
      'Take a widget off a dashboard. The App and its widget stay available and can be added again.',
  },
  {
    path: ['notification', 'list'],
    usage:
      'notification list [--source-type app|channel|platform|user] [--source <id>] [--kind <kind>] [--status unrouted|pending|delivered|partial|failed] [--reply-state awaiting|answered] [--limit <1-100>] [--cursor <id>]',
    description:
      'List notifications, newest first; --reply-state lists reply forms awaiting an answer or answered.',
  },
  {
    path: ['notification', 'get'],
    usage: 'notification get <id>',
    description:
      'Inspect a notification and every delivery, including App result strings, its reply form, the answer and the answer deliveries.',
  },
  {
    path: ['notification', 'test'],
    usage: 'notification test <destination-id>',
    description: 'Send a test notification straight to one destination.',
  },
  {
    path: ['notification', 'send'],
    usage:
      'notification send (--channel <id> --kind <kind> | --group <id> | --destination <id>) --title <title> [--kind <kind>] [--body <text>] [--url <url> [--no-auto-open-url]] [--priority <lowest|low|normal|high>] [--data <json-object>] [--dedupe-key <key>] [--occurred-at <iso-8601>] [--reply <json> | --reply-file <path|->]',
    description:
      'Send a notification. --channel sends as that Channel and its routes decide where it goes; --group or --destination (a device, webhook or App from destination list) delivers straight there from you, with --kind optional. Tapping it on a phone opens --url unless --no-auto-open-url is set or it has a reply form. --priority (also -2, -1, 0, 1; write --priority=-1 for negatives) defaults to normal: lowest stays in history and reaches webhooks and Apps without a phone push, low arrives quietly, high is time-sensitive and shows during Focus and Do Not Disturb. --reply asks for one answer ({fields:[{id,type:buttons|single|multiple|text,label,options:[{id,label}]}]}); response routes deliver the answer.',
  },
  {
    path: ['notification', 'update'],
    usage:
      'notification update <notification-id> [--title <title>] [--body <text> | --clear-body] [--url <url> | --clear-url] [--auto-open-url | --no-auto-open-url] [--data <json-object> | --clear-data] [--silent]',
    description:
      'Edit any notification by id and alert phones again, even with unchanged content. Use --silent to only change content. With no fields, repeats the alert. Destinations that take edits receive hatch.notification.updated.',
  },
  {
    path: ['notification', 'recall'],
    usage: 'notification recall <notification-id>',
    description:
      'Recall any notification by id, whatever sent it; cannot be undone. Phones remove it; destinations that have not received it never will.',
  },
  {
    path: ['notification', 'respond'],
    usage:
      'notification respond <notification-id> (--answer <field-id>=<value>... | --answers <json> | --answers-file <path|->)',
    description:
      'Answer a notification reply form as the signed-in user; one answer per notification, final once sent. Repeat --answer for each option of a multiple field. Sends the answer to matching response routes.',
  },
  {
    path: ['notification', 'delete'],
    usage: 'notification delete <notification-id> --yes',
    description:
      'Permanently delete any notification and its delivery history; cannot be undone, so --yes is required. Nothing is sent: copies phones, webhooks and Apps already received stay, so recall first to remove it from phones. Deliveries not yet made are dropped.',
  },
  {
    path: ['notification', 'retry'],
    usage: 'notification retry <delivery-id>',
    description:
      'Queue a failed delivery (of a notification or of its answer) for a fresh series of attempts.',
  },
  {
    path: ['notification', 'sources'],
    usage: 'notification sources',
    description:
      'List Apps and Channels with the notification kinds they declare.',
  },
  {
    path: ['notification', 'apns-status'],
    usage: 'notification apns-status',
    description:
      'Show which APNs key this instance uses for iOS device deliveries.',
  },
  {
    path: ['notification', 'destination', 'list'],
    usage: 'notification destination list',
    description: 'List devices, webhooks and App destinations.',
  },
  ...(['enable', 'disable', 'delete'] as const).map((verb) => ({
    path: ['notification', 'destination', verb],
    usage: `notification destination ${verb} <id>`,
    description: `${verb[0].toUpperCase()}${verb.slice(1)} a destination. App destinations can only be enabled or disabled.`,
  })),
  {
    path: ['notification', 'destination', 'rename'],
    usage: 'notification destination rename <id> <name>',
    description: 'Rename a device or webhook destination.',
  },
  {
    path: ['notification', 'webhook', 'create'],
    usage:
      'notification webhook create --name <name> --url <url> [--lifecycle-events]',
    description:
      'Add a webhook destination; prints its signing secret once. --lifecycle-events also sends edits and recalls.',
  },
  {
    path: ['notification', 'webhook', 'update'],
    usage:
      'notification webhook update <id> [--name <name>] [--url <url>] [--lifecycle-events | --no-lifecycle-events]',
    description:
      'Change a webhook name, URL, or whether it receives edits and recalls.',
  },
  {
    path: ['notification', 'webhook', 'rotate-secret'],
    usage: 'notification webhook rotate-secret <id>',
    description: 'Replace a webhook signing secret; prints it once.',
  },
  {
    path: ['notification', 'webhook', 'delete'],
    usage: 'notification webhook delete <id>',
    description: 'Delete a webhook destination.',
  },
  {
    path: ['notification', 'group', 'list'],
    usage: 'notification group list',
    description: 'List destination groups.',
  },
  {
    path: ['notification', 'group', 'create'],
    usage:
      'notification group create --name <name> [--description <text>] [--destination <id>]... [--auto-add-devices]',
    description:
      'Create a destination group; --auto-add-devices adds devices registered later.',
  },
  {
    path: ['notification', 'group', 'update'],
    usage:
      'notification group update <id> [--name <name>] [--description <text>] [--destination <id>... | --clear-destinations] [--auto-add-devices | --no-auto-add-devices]',
    description: 'Change a group; --destination replaces the full member list.',
  },
  {
    path: ['notification', 'group', 'delete'],
    usage: 'notification group delete <id>',
    description: 'Delete a group and the routes that target it.',
  },
  {
    path: ['notification', 'route', 'list'],
    usage: 'notification route list',
    description: 'List routing rules.',
  },
  {
    path: ['notification', 'route', 'create'],
    usage:
      'notification route create --source-type app|channel|any [--source <id>] [--kind <kind>] (--group <id> | --destination <id>) [--name <name>] [--disabled]',
    description:
      'Route matching notifications to a group or one destination. Omit --source/--kind to match any.',
  },
  {
    path: ['notification', 'route', 'update'],
    usage:
      'notification route update <id> [--source-type app|channel|any] [--source <id> | --any-source] [--kind <kind> | --any-kind] [--group <id> | --destination <id>] [--name <name>] [--enable | --disable]',
    description: 'Change a routing rule.',
  },
  {
    path: ['notification', 'route', 'delete'],
    usage: 'notification route delete <id>',
    description: 'Delete a routing rule.',
  },
  {
    path: ['notification', 'response-route', 'list'],
    usage: 'notification response-route list [--limit <1-100>] [--cursor <id>]',
    description:
      'List response routes, oldest first: where answers to reply forms go. Prints the next cursor when more remain.',
  },
  {
    path: ['notification', 'response-route', 'create'],
    usage:
      'notification response-route create --source-type app|channel|any [--source <id>] [--kind <kind>] --destination <id> [--name <name>] [--disabled]',
    description:
      'Send answers to matching notifications to a webhook, or to an App whose manifest sets notifications.destination.responses. Omit --source/--kind to match any.',
  },
  {
    path: ['notification', 'response-route', 'update'],
    usage:
      'notification response-route update <id> [--source-type app|channel|any] [--source <id> | --any-source] [--kind <kind> | --any-kind] [--destination <id>] [--name <name>] [--enable | --disable]',
    description: 'Change a response route.',
  },
  {
    path: ['notification', 'response-route', 'delete'],
    usage: 'notification response-route delete <id>',
    description: 'Delete a response route.',
  },
  {
    path: ['notification', 'channel', 'list'],
    usage: 'notification channel list',
    description: 'List external notification channels and their push URLs.',
  },
  {
    path: ['notification', 'channel', 'create'],
    usage:
      'notification channel create --name <name> [--description <text>] --kind <kind>[:<display name>]... [--kind-description <kind>=<text>]...',
    description:
      'Create a channel for external systems; prints its push URL and token once.',
  },
  {
    path: ['notification', 'channel', 'update'],
    usage:
      'notification channel update <id> [--name <name>] [--description <text>] [--kind <kind>[:<display name>]... [--kind-description <kind>=<text>]...] [--enable | --disable]',
    description:
      'Change a channel; --kind replaces the full kind list, so repeat every kind with its name and description.',
  },
  {
    path: ['notification', 'channel', 'rotate-token'],
    usage: 'notification channel rotate-token <id>',
    description: 'Replace a channel token; prints it once.',
  },
  {
    path: ['notification', 'channel', 'delete'],
    usage: 'notification channel delete <id>',
    description: 'Delete a channel and the routes that name it.',
  },
];

export const commandDefinitions = definitions.map((definition) => ({
  ...definition,
  supported: true,
}));
