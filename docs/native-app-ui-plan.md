# App 原生界面：组件库、设计规范、原生壳与原生能力

实施方案。状态：提议中。2026-11-24 在 Desk 改版合并后修订（见 [platform-redesign-plan.md](platform-redesign-plan.md)，PR #267、#269、#279、#280、#282）。第 0 阶段的第一轮验证已完成（第 2 节），组件库可以开工；其余都还没开始。

下文的标注：**[事实]** 已在本仓库、spike 或所引文档中核实；**[决定]** 本方案做出的选择；**[假设]** 需要在第 0 阶段、或在依赖它的阶段开始时验证。

## 与用户确定的事项

2026-11-24 确定。目前没有未决问题。

1. **主题是可编辑的数据**：一小组语义值、预设和主题文件，而不是能改每个令牌的自由编辑器。深色预设随之提供（3.7 节）。
2. **原生能力的顺序**（第 11 节）：先做授权框架、后台任务、小组件和 Live Activity 的布局解释器；再做全屏、原生音视频、菜单栏、闹钟和快捷指令；最后做健康数据、设备上的 HTTP 服务和桌面快捷方式。
3. **第 1 阶段结束后，新 App 默认使用原生运行时。** 从那时起，新 App 在 Web 上风格统一；在 Mobile 和 macOS 应用里先以 NSH 的 Web 构建运行，直到第 5、6 阶段换成原生视图。
4. **后台任务是两件事。** 服务端后台任务就是 App 的后端和 App 任务（按计划、由 webhook 或由后端入队运行，带运行历史），已经存在。设备端后台任务是一项独立的原生能力，各平台尽力提供；在做不成的平台上就不提供（3.8 节）。
5. **桌面图标是两件事。** 快捷方式通过浏览器的“添加到主屏幕”添加，可以用任意图标（3.8 节）。独立应用是一个真正的应用，有自己的图标，按 App 单独制作（3.9 节）。
6. **Mobile 应用暂时留在 Expo，原生代码不依赖 React Native。** 现在不重写。壳里新增的原生代码（会话管理器、桥接、授权、各项原生能力）都写成纯 Swift / Kotlin 库，Expo 只包一层薄模块。是否把宿主换成原生薄壳、把平台自己的界面改用 NSH 来写，在第 5 阶段开始时决定（3.6 节、第 11 节）。

## 1. 目标、范围与完成标准

在 Hatch 里生成的 App 外观不统一，也没有原生的感觉。根本原因是 App 没有共享的界面层：`templates/default-app` 只依赖 React、TanStack 和一套图标，所以每个样式都由 Agent 从零写起 **[事实]**。

目标：

1. 一个组件库（`@hatch/ui`）和一份成文的设计规范，所有新 App 都使用。思路和 ChatGPT 的 Intelligent UI 一致：一份封闭的组件目录，由模型组合，上线前由机器检查。
2. 主题是数据。实例有一个主题：一个预设，或者基于一小组语义值的自定义主题，再加上强调色。平台界面和所有 App 在运行时跟随它，不需要改 App 代码。深色预设是其中一部分。
3. App 用同一份源码，在 iOS、Android 和 macOS 上用平台原生控件渲染，在 Web 上渲染为 DOM。
4. 每个壳（包括 Web）都能运行多个已部署的 App：用户在它们之间切换时不丢状态；在桌面、平板和 Web 上可以同时显示多个。
5. 原生运行时的 App 可以使用原生功能（小组件、Live Activity、音视频、闹钟、健康数据等）。每项功能在壳里做一次，由 App 的数据驱动，并受按 App 的授权控制。给某个 App 加上一项功能不需要发新壳。
6. 单个 App 可以打包成独立的 Mac 或 iOS 应用：同一个后端、同一份壳代码，有自己的名字、图标和 bundle id，打开后直接进入该 App。

范围：在平台内生成并部署的 App，以及为了按上述方式运行它们所需的壳的工作。不在范围内：平台自身的界面（Agent 对话、桌面、设置）继续使用 Mantine 和 TanStack Start，只是改为在运行时读取主题（3.7 节）；Windows 和 Linux 的壳；自动转换现有的 React App；App Store 分发。分发只面向内部（TestFlight、ad hoc，或本机生成、或用 Developer ID 签名的 Mac 应用），所以 App Review 的 4.7.2、4.2.6 和 4.3 不约束本设计 **[决定，来自用户]**。

完成标准：

- 用默认模板创建的新 App 能通过部署；同一次部署能在 Web 界面、iOS 应用、Android 应用和 macOS 应用里打开，内容相同，并使用实例的强调色。
- `hatch theme set --accent teal` 让每个壳里已打开的原生 App 换色，不需要重新部署。
- `hatch theme set --preset desk-dark` 和 `hatch theme set --file <path>` 让 Web、Mobile 和 macOS 上的平台界面和所有已打开的 App 换肤，不需要重新部署，也不需要发新壳；文字会看不清的主题会被拒绝，并指出是哪一对颜色不合格。
- 源码里使用了目录之外的颜色、尺寸或组件的部署会失败，错误信息指出文件和行号。
- 在 Web、macOS 应用和平板上，两个 App 可以并排显示并且都能操作；在每个壳上，从一个 App 切走再切回来，会回到同一个界面，未保存的输入还在。
- 被授予某项原生能力的 App，能在一个早于该 App 构建的壳上使用这项能力；没有授权时，同样的调用会被拒绝；撤销授权在 App 下次加载时生效。
- 已部署的 App 可以生成一个带自己 Dock 图标、打开后直接进入该 App 的 Mac 应用；也可以生成一份 iOS 构建配置，用部署者自己的 Apple 账号构建出可安装的应用。
- 现有的每个 React App 照常部署、提供服务和回滚，不受影响。

## 2. 当前行为与准备工作

当前的路径 **[事实]**，2026-11-24 在 master 上核对：

- Manifest：`packages/hatch-manifest/src/app-schema.ts`。`app` 是 `{ entry, html?, routes }`（`:410-413`），没有字段表示前端的种类。`backend.runtime` 已经存在（`:401`），与此无关。
- 构建在平台服务器内进行：`src/server/apps/build.ts:552` 的 `buildApp` 物化 SDK（`materializeAppHatchSdk`，`:615`），用 esbuild 把前端打包成 `out/app/app.js` 并内联进 `out/app/index.html`（`:745-795`），每个小组件打包成 `out/widgets/<id>.js`（`:806-823`）。源码边界由 `src/toolchain/esbuild-plugins.ts:118` 的 `sourceBoundaryPlugin` 实现。
- 部署：`src/server/apps/deploy.ts:474` 的 `deployApp`。激活由一个持久化的栅栏保护，并发布 `app.deployment.activated` 事件（`:141`）。`deployments.version` 是按 App 递增的整数。
- 提供服务：`src/server/apps/serve-app.ts:26` 的 `serveAppAppFile`，由 `src/routes/app/$appSlug/embed/$.ts` 调用。响应只设置内容类型和 `cache-control`，App 页面没有设置 CSP。
- Web 嵌入：`AppSurface`（`src/components/desk/app-surface.tsx`）是唯一渲染 App 的组件。它在 `/app/<slug>/embed/` 上挂载一个同源、没有 `sandbox` 属性的 `<iframe>`。它的公开接口里没有 iframe：属性有 `app`、`route`、`visible`、`onRouteChange`、`onTitleChange`，句柄上有 `reload` 和 `navigate`。在内部，它直接读取 iframe 的地址和 `contentDocument.title`。同一时间只打开一个 App，Desk 外壳里没有“当前 App”这样的全局状态。
- App 到平台：前端包用同源的会话 Cookie 调用 `/api/app/<id>/rpc` 和数据接口（`src/server/apps/runtime-api/`）。
- Mobile（`mobile/`，Expo）：`mobile/app/apps/[id].tsx` 在交接登录之后，用无痕 WebView 打开嵌入地址（`mobile/src/ui/secure-surface.tsx`）。平板支持已开启（`supportsTablet: true`）。应用自身主屏上的小组件区域，是放在透明 `SecureSurface` 里的 Web 仪表盘画布。已有本地 Expo 模块（`mobile/modules/hatch-fold`、`hatch-push-keys`）。
- macOS（`desktop/`，Tauri 2）：一个窗口，以侧栏布局显示实例的 Web 界面（`src/components/desktop-host/`，通过 `HatchDesktop/<version>` 这个 User-Agent 选择）。登录走默认浏览器里的设备登录；会话存在钥匙串里。App 通过和 Web 上相同的 `AppSurface` 运行。可以往 Tauri 窗口里加入原生的 NSH 视图（改版方案里的 B1）。
- 令牌：`packages/hatch-design-tokens/tokens.json` 是 Web、Mobile 和桌面端的唯一来源，各端直接导入这份 JSON。其中的 `light` 块使用 shadcn 的 `cssVars` 名称，也就是 NSH 的 `theme.json` 读取的名称。`accents` 有 indigo、teal、clay 和 violet；`dark` 是 `null`。
- 主题设置：`platformConfig` 的 `ui.theme` 键保存 `{ accent }`（`src/server/platform-config.ts:82`）。`ThemeService.GetTheme` 和 `SetTheme`、`hatch theme get` 和 `hatch theme set --accent`、外观设置页，以及平台事件 `theme.updated` 都已存在。

技术选型 **[决定]**：Native Shell（NSH，`nsh.dev`，Apache-2.0，固定在 0.6.1，也就是验证所用的版本）。三个候选里只有它能在运行时把界面加载进沙箱；`mygo` 和 `asuka` 把界面编译进二进制，对于壳安装之后才生成的 App 行不通。

Spike 结果 **[事实]**（一个 TSX App、一个模拟的 `@hatch/ui`、三种宿主）：

| 检查项               | Web                         | iOS 模拟器                 | macOS（Rust 宿主） |
| -------------------- | --------------------------- | -------------------------- | ------------------ |
| 运行时加载           | 可以（`createPlayer`）      | 可以（通过 HTTP 取签名包） | 可以（签名包）     |
| 被篡改的包           | 不适用                      | 拒绝                       | 拒绝               |
| 宿主桥接数据         | 可以                        | 可以                       | 可以               |
| 未授权的宿主调用     | 拒绝                        | 拒绝                       | 拒绝               |
| 未授权的网络请求     | **没有拦住**                | 拒绝                       | 拒绝               |
| App 能访问到宿主页面 | **能，通过 `top.document`** | 不能                       | 不能               |
| 主题变化             | 实时                        | 实时                       | 加载前应用         |

其他实测结果：App 包 4.6 KB，签名包 26 KB，构建 28 ms；Web 运行时 brotli 压缩后 1.15 MB；`nsh check` 抓出了初稿里全部三处 API 错误；NSH 的 crate 需要 rustc 1.97 或更高。那个包里没有 Connect 客户端；下面的验证测了更接近实际的包。

一个宿主里运行多个 App **[事实]**，在 macOS 上实测：同一个窗口里的两个引擎，数据和主题互相独立。一个引擎时常驻内存 85 MB，八个时 95 MB，所以每多一个小 App 大约多 1 到 1.5 MB。

在 Web 上 **[事实]**：一个文档里放三个 player，以及三个 iframe 各放一个 player，两种方式都能运行三个 App，数据、主题和输入状态互相独立；被隐藏的面板保留了没发出的草稿。同一个文档里，第一个 App 在 180 ms 就绪，三个全部就绪用了 352 ms，运行时只下载一次。没有测的：Web 上每个 App 的内存占用，以及怎样干净地销毁一个 player（`player.stop()` 返回后视图没有被移除）。

NSH 给宿主提供了什么 **[事实]**，来自 2026-11-22 阅读的 NSH 文档和源码：

- **宿主通道。** App 里有 `host.call(name, args)`、`host.post`、`host.on` 和 `host.params`；`NshAppView`（Swift）、`NshView`（Android）和 `AppView::host()`（Rust）上有 `handle(name)` 和 `send(name, data)`。数据以 JSON 传递。除非 App 另行指定，调用在 30 秒后超时。
- **原生组件。** 宿主用一个名字注册原生视图，App 在 TSX 里通过属性、事件和命令使用它。名字必须在包加载之前注册。Web 上没有原生组件。**App 的能力声明不约束原生组件。**
- **能力。** App 在 `nsh.json` 里声明能力；宿主授予其中的一个子集；一次调用必须同时通过两者。**什么都不声明的 App 可以做任何事**，所以宿主必须始终显式设置授权。
- **包。** 包里有 JS、字节码、source map、导入的图片和字体，以及声明的能力。包会声明它需要的 `minRuntime`。
- **没有提供的。** 没有不带视图的引擎：引擎属于 `NshAppView` 或 `NshView`，推送回调到达的是原生代码，而不是 App 的 JS。不支持在应用扩展（小组件、Live Activity、App Intents）里运行。这两点都是在文档和源码里没有找到，而不是文档明确写出的限制。

影响设计的约束：

- 在 Web 上，NSH 不把 App 和宿主页面隔离开。Web 外壳必须自己守住边界。
- NSH 的信任库会拒绝构建号低于它为该 App 接受过的最高值的包。Hatch 的回滚不能撞上这一点（3.4 节）。
- NSH 还没到 1.0，会发布破坏性变更。运行时版本要固定，并按每次部署记录（第 6 节）。
- App 包能改变的只有 JS、资源，以及它使用壳里已有的哪些宿主调用和原生组件。其他都需要新的壳二进制：原生代码、Info.plist 键和用途说明、entitlement、应用扩展、Android 权限和 manifest 组件，以及更新的 NSH 运行时（3.8 节）。

验证结果 **[事实]**，2026-11-24 用 NSH 0.6.1 进行。验证用的 App 按真实的 App 根目录布局，使用真实的 `@hatch/app` SDK、默认模板的 proto 和真实的 Connect 服务。证据和 spike 源码在当天的验证记录里。

| 假设                                      | 结果                                |
| ----------------------------------------- | ----------------------------------- |
| A2. 打包器能解析 SDK 和生成的代码         | 成立，条件见下                      |
| A3. Connect 一元调用能走 `host.call`      | 成立，无界面环境和 Web 播放页都通过 |
| A4. 包可以用更高的构建号重新签名          | **不成立**；重新打包可行            |
| A5. `nsh test` 能在无界面环境抓到启动错误 | 成立                                |
| A8. 图标怎么发                            | 已定：JS 模块里的路径数据           |

这些结果在设计里确定了以下几点：

- **解析（A2）。** `nsh.json` 必须放在 App 根目录，App 导入的所有东西都必须在这个目录之下。前缀别名不会读取包的 `exports`，所以平台为 SDK 的每个入口生成一条精确别名（`@hatch/app`、`@hatch/app/data`、`@hatch/ui` 等），来源和生成 `.hatch/import-map.json` 的定义相同。`nsh check` 还需要入口旁边有一个 `tsconfig.json`。两个文件都由平台生成，Agent 不写。生成的 Connect 客户端和 npm 包不需要配置就能解析。
- **桥接（A3）。** 数据以 JSON 传递，所以传输层使用 Connect 的 JSON 编码。处理函数抛出的错误到了 App 这边只剩一条消息和一个通用错误码，所以每个 `hatch.*` 处理函数都用一个信封作为返回值（`ok` 加结果，或者 `ok: false` 加 Connect 错误码和消息）。桥上不能取消调用，只有调用自己的超时。
- **回滚（A4）。** 重新签名会保留包的内容，构建号也包括在内。所以 3.4 节改用重新打包。一个基于 `nsh-package` crate 的小程序，不经过打包器，就把存下来的包用更高的构建号重建了出来；信任库依次接受了 5、6、作为 7 的重新构建、作为 8 的重新打包，之后拒绝了 5 和 7。这是在 crate 的信任库上跑的，不是在设备上。
- **启动检查（A5）。** 正常的 App 退出码为 0；渲染时抛错、或启动 300 ms 后抛错的 App 退出码为 1，并给出文件和行号。无界面宿主里没有 `fetch`，所以启动检查用预置数据应答宿主调用。它会在服务器上运行 App 代码（第 9 节）。
- **图标（A8）。** 被可达模块导入的 SVG 即使没用到也会被打进包，而没用到的常量会被去掉。所以 `@hatch/ui` 把图标做成 JS 模块里的路径数据，用 `Path2D` 绘制。绘制只在 Web 播放页里检查过。
- **体积。** 带 Connect 客户端的发布包约 107 KB。把 source map 放在包里的签名包有 830 KB，所以实际分发的包把 source map 放在外面。打包后的 Web 运行时 brotli 压缩后 1.06 MB，另加 0.2 MB 的加载器；未打包的运行时有 40 MB，不能拿来对外提供。
- **Web 播放页。** 除了 `connect-src 'self'`，它还需要 `script-src 'self' 'wasm-unsafe-eval'` 和 `img-src 'self' blob: data:`。它的授权以能力声明的 JSON 文本形式传入，由页面提供。
- **macOS。** NSH 的 iOS 和 Android 视图加载签名包；它的 macOS `AppView` 加载的是 bundle。所以 macOS 的壳要自己用 `nsh-package` 验证包，再加载验证过的 bundle。
- **主题。** NSH 有 `setTheme`，接受 shadcn 的 `cssVars` 结构，在下一帧生效，所以实时的主题变化可以作为宿主事件下发。
- **NSH 自带的模块。** 0.6.1 的类型声明里有 `Tray`、包含全屏在内的 `Window` 模式、`Notifications`、`AudioPlayer`、`Video`、`Share`、`Haptics` 和 `lifecycle()`。这些都没有实际跑过（A16）。

尚未验证 **[假设]**：

- A1. Android：`nsh.aar` 能加载同一个包，沙箱结果也相同。
- A6. `NativeShell.xcframework` 和 `nsh.aar` 能和 React Native 一起链接进 Expo 应用，体积增加可以接受。
- A7. 输入法（中日韩文字的组合输入）和读屏在每个壳上都表现正确。
- A9. 多个引擎能在 iOS 和 Android 上并排运行，就像在 macOS 上一样，在 Expo 应用里也可以。
- A10. 被隐藏的引擎还会继续做什么（定时器、动画），壳能不能让它暂停。
- A11. macOS：在 Tauri 窗口里，放在 `AppSurface` 矩形区域之上的原生 NSH 视图能跟随布局、滚动和缩放，能正确取得键盘焦点，并且在 Web 界面在它上方打开菜单、对话框或搜索面板时能被盖住。B1 只证明了能加入一个视图。
- A12. 可以用 config plugin 往 Expo 应用里加入小组件和 Live Activity 扩展，并且扩展能在自己的内存限制内，渲染从 App Group 读到的 JSON 视图树。
- A13. 引擎能在没有可见视图的情况下运行，用于各平台的设备端后台任务；在 iOS 上能在后台任务的时间窗口内运行。做不到的平台就没有这项能力。
- A14. 生成的、ad-hoc 签名的 Mac 包装应用能保有自己的 Dock 图标和窗口，能沿用或重新走一遍壳的登录，并且能显示通知。
- A15. Expo 工程能按变体配置用第二个 bundle id 构建，推送和 App Group 的标识对这个 id 有效。
- A16. NSH 自带的模块（托盘、全屏、音频、视频）能在嵌入式视图里工作，并且可以按 App 控制。能用的地方，相应的能力就用它们，而不是新写壳代码。
- A17. iOS 和 Android 上的信任库会像 crate 的信任库一样接受重新打包的包；原生宿主能承载 Web 播放页承载过的 Connect JSON 请求。
- A18. 从桌面快捷方式打开的页面，能通过链接直接交给已安装的壳，不需要用户再点一次；iOS 和 Android 都如此。
- A19. NSH 能承载平台自己的 Mobile 界面：对话页的流式渲染、附件和图片选择，以及用原生组件内嵌 WebView。

第 1 阶段不依赖以上任何一条。A1、A6、A9 和 A17 是第 5 阶段的前提；A11 是第 6 阶段原生视图的前提；A12、A13 和 A16 是用到它们的那些能力的前提；A14 和 A15 是第 8 阶段的前提。

如果 A1 或 A6 不成立，Mobile 上的 `native` App 先在 WebView 里以 NSH 的 Web 构建运行；组件库、主题和部署检查不受影响。A6 不成立也是把 Mobile 宿主从 Expo 换成原生薄壳的直接理由（3.6 节的宿主决策点）。

## 3. 实现方式

### 3.1 两种前端运行时

Manifest 里的 `app.runtime` 选择前端运行时：`web`（现在的 React 包，缺省值）或 `native`（NSH TSX）**[决定]**。桌面上的小组件在本方案里继续使用 Web 运行时，以后再迁移（第 11 节）。

`native` App 的源码：

```text
app/main.tsx     入口：用 @hatch/ui 的 `mount` 挂载根组件
app/custom/      可选的逃生口（3.3 节）
```

前端没有 `index.html`，也没有 npm 的界面依赖。平台在 App 根目录生成 `nsh.json`，并生成 `app/tsconfig.json`；两者都不由人或 Agent 编写。后端、proto、数据结构和 manifest 的其余部分不变。

### 3.2 `@hatch/ui`

放在 `sdk-internal/ui`，像 `@hatch/app` 一样被物化到 `.hatch/`（`materializeAppHatchSdk`）。基于 `nsh/base` 的无样式组件。它的令牌从 `packages/hatch-design-tokens/tokens.json` 生成，组件按 `DESIGN.md` 里的组件规格实现（按钮、输入框、卡片、列表行等），这样 App 和它周围的平台看起来是同一个产品 **[决定]**。

目录第一版 **[决定]**：

- 布局：`Page`、`Section`、`Stack`、`Row`、`Grid`、`Card`、`Divider`。
- 导航：`AppShell`（手机上是标签栏，桌面和宽屏 Web 上是侧栏）、`NavStack`、`Tabs`。
- 输入：`Button`、`IconButton`、`TextField`、`TextArea`、`NumberField`、`Select`、`Combobox`、`Checkbox`、`Switch`、`RadioGroup`、`Slider`、`DatePicker`、`Form`、`Field`。
- 展示：`Text`、`Heading`、`Badge`、`Avatar`、`List`、`ListItem`、`DataTable`、`Stat`、`Progress`、`EmptyState`、`Skeleton`、`Icon`。
- 反馈：`Dialog`、`Sheet`、`AlertDialog`、`Toast`、`Tooltip`、`Menu`。
- 页面模式：`ListDetailPage`、`FormPage`、`SettingsPage`、`DashboardPage`。
- 状态与平台（重新导出，让 App 只需导入一个包）：`signal`、`memo`、`effect`、`resource`、`If`、`Each`。

组件强制执行的规则：

- 任何组件都不接受 `class` 或 `style`。变化通过带类型的属性表达（`tone`、`size`、`gap="md"`），全部映射到令牌。
- 平台差异（导航模式、用 sheet 还是 dialog、密度）在组件内部决定，依据是 `platform.idiom` 和 App 自己所在面板的大小。桌面上处于窄窗口或分栏里的 App 按窄 App 布局；布局跟随面板，而不是屏幕。
- 每个可交互的组件都设置自己的无障碍角色和标签。

### 3.3 设计规范与部署检查

规范是 `skills/building-apps/references/design-system.md`：哪种界面用哪种模式、间距和层级规则、文案规则，以及由组件类型生成的每个组件的目录页。

针对 `native` App 的部署检查，加在 `buildApp` 里现有的源码检查之后：

1. `nsh check`：类型检查，其中包括令牌名。
2. 源码边界：`app/custom/` 之外的文件只能从 `@hatch/ui` 导入界面，不能导入 `nsh` 或 `nsh/base`；实现为 `sourceBoundaryPlugin` 旁边的一个解析检查。
3. `nsh build --release`，把未知类名的警告提升为错误。
4. 启动检查：`nsh test` 在无界面环境里用预置的宿主应答打开 App，App 抛错就让部署失败。

`app/custom/` 是目录表达不了的东西（画布、游戏）的逃生口。那里的文件可以直接使用 `nsh`，但仍然只能用主题令牌。构建日志会列出每个 custom 文件，让它的使用情况保持可见。

### 3.4 打包、签名与回滚

- 实例拥有一把根密钥和一把发布密钥，在第一次原生部署时创建，存放在 `HATCH_DATA_DIR/keys` 下，权限仅限所有者。
- 部署成功后，把 `out/app/bundle.js`（Web 用）和未签名的包的输入写进不可变的产物目录。
- 签名的 `.nshpkg` 在某次部署变成线上版本时产生，不论是通过部署还是回滚；构建号等于一个只增不减的、按 App 的激活计数器 **[决定]**。所以回滚是用更新的构建号发布更旧的代码，壳会接受。
- 包通过重新打包产生，而不是重新签名，因为重新签名的包会保留原来的构建号。一个基于 `nsh-package` crate 的 Rust 小工具（版本与 `nsh` 固定一致），把存下来的包里的源码、字节码、资源和能力原样取出，用新的构建号构建出一个包。这样发出的代码逐字节相同，回滚时不需要构建环境。代价是平台镜像里多一个固定版本的二进制。
- 调用 `nsh publish` 时始终显式传入 `--id`、`--app-version` 和 `--build`，因为入口在子目录时它不会从 `nsh.json` 读取这些值。

签名能提供什么、不能提供什么：它保护传输过程中和壳的缓存里的完整性，允许加载字节码，并防止降级。它不是安全边界，因为壳信任的是用户登录的那个实例。安全边界是第 9 节的能力授权。

### 3.5 宿主桥接

`native` App 永远拿不到凭证，也不会被授予网络访问。`@hatch/app` 和生成的 Connect 客户端使用同一个传输层，`host.call('hatch.rpc' | 'hatch.data.*', ...)`，由壳用自己的会话发出 HTTP 请求 **[决定]**。调用如下：

| 名称                                                         | 用途                           |
| ------------------------------------------------------------ | ------------------------------ |
| `hatch.rpc`                                                  | 对 App 后端的 Connect 一元调用 |
| `hatch.data.query`、`hatch.data.mutate`、`hatch.data.events` | 数据表                         |
| `hatch.theme.get`，事件 `hatch.theme`                        | 当前主题和主题变化             |
| `hatch.nav.setTitle`、`hatch.nav.setRoute`                   | 标题和深链接状态               |
| `hatch.nav.open`                                             | 请壳打开另一个 App             |
| `hatch.native.supports`                                      | 这个壳提供哪些原生能力         |
| `hatch.native.<能力>.*`                                      | 原生能力（3.8 节）             |

每个处理函数都用信封应答：`{ ok: true, … }` 或 `{ ok: false, code, message }`；传输层把后者转成 `ConnectError`，因为被拒绝的宿主调用会丢掉错误码。消息使用 Connect 的 JSON 编码。调用发出后不能取消，只能以应答或超时结束。

本方案里，原生运行时不支持流式 RPC；如果 `native` App 调用了 proto 里声明的流式方法，构建会拒绝。

### 3.6 壳：一个应用，多个 App

壳是容器，不是单个 App 的查看器 **[决定]**。现在这也包括 Web：用户把“Web 上同时运行多个 App”从 Desk 改版挪到了本方案。

运行中的 App：

- 一个运行中的 App 是一个引擎，有自己的桥接通道、授权、存储目录和虚拟机限额。引擎之间不共享任何东西。在 Web 上，不论用哪种运行时，一个运行中的 App 就是一个 iframe。
- 切换时只隐藏 App 的视图，App 继续运行，所以用户回来时还在同一个界面，未保存的输入也还在。
- 打开一个已经在运行的 App 会把焦点切过去。每个壳里每个 App 只有一个运行中的副本，这样存储和数据订阅不会有歧义。
- 每个壳限制运行中 App 的数量（初始值：桌面和 Web 上 12 个，平板 6 个，手机 3 个），也限制每个引擎的堆（96 MB，而不是 NSH 默认的 256 MB）。超出上限时，停掉最久没有显示过的 App；壳记住它最后的路由，下次从那里重新打开。被停掉的 App 在内存里未保存的状态会丢失，所以 `@hatch/ui` 的表单组件通过 App 存储保存草稿。
- 对于被隐藏的 App，壳不再应答 `hatch.data.events`；重新显示时补发错过的变化。这样后台的 App 不会轮询。
- 新的部署不会在用户眼前替换正在运行的 App。壳把它标记为“有更新”，在下次打开或用户主动重新加载时加载新的包。

按设备形态的呈现方式：

| 壳    | 切换方式                    | 同时可见                                     |
| ----- | --------------------------- | -------------------------------------------- |
| Web   | Dock 和 Desk 窗口           | 多个 Desk 窗口并排；小于平板宽度时只显示一个 |
| macOS | 侧栏，以及已打开 App 的标签 | 窗口内分栏；App 也可以移到自己的窗口         |
| 平板  | 侧栏或切换器                | 两栏并排                                     |
| 手机  | 切换面板                    | 一个                                         |

各自负责什么：壳负责 App 的切换、分栏、窗口、标题栏，以及 App 之间的返回手势。App 通过 `AppShell` 和 `NavStack` 负责自己面板内的导航。面板较窄时，`AppShell` 使用顶部的标签行，所以壳的侧栏和 App 的侧栏不会并排出现。

各个壳：

- **Web。** `AppSurface` 仍然是唯一知道 App 如何渲染的地方，它增加三样东西。
  - _`native` App 的播放页。_ `/app/$appSlug/embed/` 提供一个很小的播放页，从 `/api/app-runtime/nsh/<version>/`（长期缓存）加载共享的 NSH 运行时，再加载 App 的 `bundle.js`。在 Web 上，播放页就是 App 的宿主：它用同源请求应答 `host.call`，并把 App 的授权交给 player。响应带有 `Content-Security-Policy`，包含 `connect-src 'self'`、`script-src 'self' 'wasm-unsafe-eval'` 和 `img-src 'self' blob: data:`。
  - _消息通道。_ 播放页和 `AppSurface` 通过 `postMessage` 交换路由、标题、主题、可见性和“有更新”；对 `native` App，它取代了直接读取 iframe 的做法。`web` App 继续在 `AppSurface` 内部直接读取，因为只要 App 页面还在平台的源上，给它们加上这个通道只会改变已部署 App 的契约，没有收益 **[决定]**。
  - _多个 App。_ Desk 外壳里的会话管理器为每个运行中的 App 保持一个挂载着的 `AppSurface`，并对两种运行时应用上面的规则。App 窗口可以和另一个窗口并排；Dock 标出运行中的 App；`app.deployment.activated` 触发“有更新”标记。停掉一个 App 就是移除它的 iframe，这样绕开了还没解决的 player 销毁问题。
- **iOS 和 Android。** 一个本地 Expo 模块 `mobile/modules/hatch-app-view` 封装 `NshAppView` 和 `NshView`；一个原生的会话管理器持有运行中的引擎，让它们的生命周期长于 React Native 的界面。App 界面对 `native` App 挂上运行中引擎的视图，对 `web` App 继续使用 `SecureSurface`。这个模块用会话的 bearer 取包，用实例的根密钥验证，授予能力并实现桥接。平板和展开的 Duo 使用两栏布局。
  - _原生代码不依赖 React Native **[决定，来自用户]**。_ 会话管理器、桥接、授权和各项原生能力，都放在不引用 React Native 和 Expo 的 Swift 包和 Kotlin 库里；`hatch-app-view` 这个 Expo 模块只是它们外面的一层薄封装。这样以后更换宿主时，这些代码原样带走，只需要重写界面。现有的 Mobile 应用约 1.66 万行 TypeScript，原生代码只有两个 Swift 文件 **[事实]**；后面几个阶段新增的几乎全是原生代码。
  - _宿主决策点。_ 第 5 阶段开始时，A6 和 A9 的验证结果出来后决定宿主：(a) 留在 Expo；(b) 换成每个平台一层原生薄壳（Swift、Kotlin），只负责登录、推送、会话管理、桥接和扩展。A6 或 A9 在 Expo 里不成立时选 (b)。不做 SwiftUI 加 Compose 各写一遍界面的方案，那样界面工作量翻倍，Android 会一直落后 **[决定]**。
  - _平台界面改用 NSH。_ 换成原生薄壳之后，平台自己的界面（对话、列表、设置）可以用 NSH 加 `@hatch/ui` 来写，iOS、Android 和 macOS 共用一套 TSX，平台界面和 App 用同一个组件库。前提有两个：`@hatch/ui` 已经被真实的 App 用过一轮；并且验证过 NSH 能承载对话页（流式渲染、附件、图片选择）和内嵌 WebView（给 `web` 运行时的 App 用）（A19）。在这之前不迁移。
- **macOS。** Tauri 应用继续显示实例的 Web 界面，所以从第 1 阶段起，`native` App 不需要额外工作就能通过 Web 播放页在里面运行。第 6 阶段把播放页换成原生视图：在桌面宿主里，`AppSurface` 不再挂载 iframe，而是把自己的矩形区域和可见性报告给宿主；一个 Rust 的会话管理器（`nsh-platform-macos`）为每个运行中的 App 在 Web 视图之上的那个矩形位置放一个 `AppView`。`AppView` 加载的是 bundle 而不是签名包，所以会话管理器先用 `nsh-package` 验证每个包。当 Web 界面打开必须盖住 App 的东西（菜单、对话框、搜索面板）时，宿主把原生视图换成一张快照，直到它关闭。这依赖 A11。如果 A11 不成立，`native` App 在自己的原生窗口里打开，主窗口继续用 Web 播放页。这个 crate 固定 rustc 1.97+，并对构建依赖设置 `strip = false`（被 strip 的过程宏库在 macOS 27 上加载失败）。

### 3.7 主题

第 1 阶段不需要新的主题工作：App 的主题就是设计令牌加上所选的强调色。每个壳都已经带有令牌文件，也已经从 `ThemeService` 读取强调色，所以各个壳在本地构建 NSH 主题并应用到自己的引擎上；收到 `theme.updated` 时重新构建，并推送 `hatch.theme` 事件，`@hatch/ui` 用 NSH 的 `setTheme` 应用它。

第 3 阶段让主题成为整个产品的可编辑数据 **[决定，来自用户]**。它不是能改每个令牌的自由编辑器，因为大多数令牌并不独立：半透明的 Dock、分隔线、悬停色、阴影和桌面的背景色块，都是对着基础颜色调出来的，逐个去改会得到看不清的组合。

**主题是什么。** 一份主题文档包含一小组语义值：

- `appearance`：`light` 或 `dark`；
- 颜色：`background`、`foreground`、`card`、`primary`、`secondary`、`muted`、`muted-foreground`、`border`、`destructive`；
- `radius`：一个基准值，各级圆角按它缩放；
- `fonts`：`sans` 和 `mono`，都只能从壳里打包的字体中选。

其余的值都由一个函数 `resolveTheme` 从这些值推导出来：十级色阶、成对的 `-foreground` 颜色、半透明的界面层、分隔线、悬停和按下的颜色、阴影和背景色块的色调。强调色现在已经是这样推导的。现有 `tokens.json` 里的值成为 `desk` 预设，这个函数必须能从它精确重现今天的外观；用一个测试对比两者。

**预设与自定义主题。** 预设放在 `packages/hatch-design-tokens` 里：`desk`（今天的外观，默认值）和 `desk-dark`（填上现在空着的 `dark` 块）。自定义主题是以文件形式提供的一份主题文档。强调色保持现在的用法：一个快捷选择，替换当前主题的 `primary`。

**浅色、深色和跟随系统。** 设置里有一个 `mode`（`light`、`dark` 或 `system`），以及浅色用的主题和深色用的主题。默认是 `light` 加 `desk`，也就是今天的行为。选 `system` 时，每个客户端按所在设备的外观来选。

**在哪里解析 [决定]。** 由服务器解析主题，`ThemeService.GetTheme` 返回解析好的整套令牌。这样没有哪个壳需要重新实现推导逻辑，新的预设或自定义主题也不用发版就能到达已安装的壳。每个壳保留内置的 `desk` 令牌，用于首次绘制和离线时使用，并按实例缓存上一次解析好的主题，就像 Mobile 现在缓存强调色一样。

**每个客户端要改什么。**

- Web：颜色已经是启动时由 `src/ui/theme/` 设置的 CSS 变量；改为从解析好的主题设置，而不是从令牌文件。
- Mobile：`mobile/src/ui/theme.ts` 里的调色板现在是构建时从令牌文件读的，要改成运行时读取的值。这是这个阶段最大的一块工作。
- macOS：主窗口就是 Web 界面，所以跟随 Web。首次运行页继续用内置令牌。窗口的系统外观跟随主题的 `appearance`。
- App：不用改。`@hatch/ui` 只引用令牌名，壳通过 `hatch.theme` 推送解析好的主题。

**保存主题时的校验。** 拒绝未知的键和无法解析的颜色。对每一对前景和背景检查文字对比度（`foreground` 在 `background` 和 `card` 上、`muted-foreground` 在 `background` 上、推导出的文字颜色在 `primary` 上）；低于 4.5:1 的主题会被拒绝，并指出不合格的那一对颜色和它的比值。不在打包字体列表里的字体会被拒绝。

**谁来编辑主题。** 外观设置页提供模式、预设和强调色。自定义主题通过 `hatch theme set --file` 设置，Agent 根据描述生成主题也走这个入口。本方案不做逐项调整的可视化编辑器。

### 3.8 原生能力

用户希望原生 App 能用上原生功能，参照 JSBox：后台任务、菜单栏项、Live Activity、原生音视频、可选的全屏、桌面小组件、每个 App 的桌面图标、入站 HTTP 服务、Siri 和快捷指令、闹钟（AlarmKit）和健康数据（HealthKit）。

原则 **[决定]**：每项能力在壳里作为通用功能做一次，由 App 的数据驱动。没有哪项能力需要为单个 App 发一次壳。壳构建时固定下来的是能力的集合和它们的上限（数据类型、小组件尺寸、槽位数量）。

哪些随 App 部署变化，哪些需要新的壳 **[事实]**：

| 随 App 部署变化                     | 需要新构建的壳                       |
| ----------------------------------- | ------------------------------------ |
| TSX 逻辑、界面和资源                | 任何新的原生代码或原生组件           |
| 调用哪些已有的宿主调用、传什么数据  | Info.plist 键、用途说明、entitlement |
| 使用哪些已注册的原生组件            | 应用扩展（小组件、Live Activity 等） |
| 小组件和 Live Activity 的布局与数据 | Android 权限和 manifest 组件         |
| 它声明的能力                        | 更新的 NSH 运行时                    |

**声明、授权与执行**

- Manifest 增加 `app.native`：一份能力 id 的列表，带上各自的静态参数（例如 App 要读取的健康数据类型）。
- 声明只是请求。App 只有在获得授权之后才得到这项能力；授权按 App 存在实例上（第 4 节），在 App 的管理页或 CLI 里授予（第 5 节）。新增能力的部署不会被阻塞；在授权之前，App 不带这项能力运行，`@hatch/app` 会报告它不可用。
- 敏感能力还需要每台设备上的同意。健康数据、摄像头和麦克风采集、本机 HTTP 服务和闹钟，在 App 第一次在某台设备上使用时，壳会弹出一个写明 App 名字的提示。系统自己的权限提示不够，因为它是对整个壳问一次，而不是按 App 问。
- 壳交给 NSH 的授权里，只列出这个 App 被授予的那些 `hatch.native.*` 调用名。NSH 不管控原生组件，所以每个原生组件的工厂自己检查 App 的授权，没有授权时渲染一个空的占位。
- 各个壳提供的能力不同。壳报告自己的能力集合和版本；App 可以通过 `hatch.native.supports` 做适配；调用不支持的能力会以 NSH 的 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 失败。

**两块共用的基础设施**

- _Glance 布局。_ 小组件和 Live Activity 是由应用扩展画的，不是由 App 画的；而且没有找到在扩展里运行 NSH 的办法（第 2 节）。所以壳的扩展里包含一个解释器，解释一棵很小的 JSON 视图树（文本、图片、堆叠、进度、仪表、带动作 id 的按钮）；用 SwiftUI 为 WidgetKit 和 ActivityKit 实现一次，用 Jetpack Glance 实现一次。Agent 不写 JSON：`@hatch/ui/glance` 的组件会序列化成它。视图树和数据通过设备上的 App Group 到达扩展，或者由平台推送过来。点按会执行一个通用的 intent，带上 App id 和动作 id。
- _服务端推送。_ App 已经有后端，App 任务也已经能按计划和 webhook 运行。那是服务端的后台任务，已经存在，不属于原生能力。本方案新增的是从它到设备的通路：一条推送可以显示通知、更新小组件，或者启动、更新 Live Activity；壳没在运行时也有效。

**设备端后台任务。** 一项独立的能力，用于必须在设备上做的事（读取健康数据、本地文件、局域网）。App 声明有名字的后台任务和触发条件（间隔、推送、系统事件）。壳在没有可见视图的情况下加载 App，告诉它要跑哪个任务，并给它一个时间预算；App 做完后报告。这项能力是尽力而为 **[决定，来自用户]**：

- macOS：只要壳在运行就可以；用登录项让壳保持运行。
- Android：通过 WorkManager 调度；长时间的任务需要一个在壳里声明过类型的前台服务。
- iOS：只在系统选定的时间窗口里运行，每次约 30 秒；用户强制退出壳之后不会再运行。

三者都依赖 A13。如果某个平台上引擎无法在没有视图的情况下运行，这个平台就把这项能力报告为不支持，App 退回到下次被打开时再执行任务。

**桌面快捷方式。** 快捷方式是跳转进壳；它不是 3.9 节的独立应用。它通过浏览器添加，这是在 iOS 上唯一可行、并且允许任意图标的途径 **[决定，来自用户]**：

- 实例为每个 App 提供一个快捷方式页面。页面把 App 的名字和图标作为主屏幕标题和图标，并显示“添加到主屏幕”的步骤。壳和 App 的管理页会在浏览器里打开它。
- 图标默认是 App 的图标。用户可以给快捷方式换一张图片；它和 App 图标存在一起，通过和 App 图标相同的 RPC 和 CLI 设置。
- 从主屏幕打开时，页面把用户交给壳里的那个 App（A18）。如果没有安装壳，或者跳转被拦住，页面显示一个“打开”按钮，也可以就在那里以网页方式运行 App。
- 这个页面是从不带会话的主屏幕入口到达的，所以它的地址里带一个按 App 的、可以撤销的令牌。它只会暴露 App 的名字和图标。
- Android 还可以在壳里用 `requestPinShortcut` 固定快捷方式。在 Mac 上，同一个页面可以配合 Safari 的“添加到程序坞”使用。

**各项能力**

| 能力            | 提供方式                                         | iOS                          | Android                           | macOS                  |
| --------------- | ------------------------------------------------ | ---------------------------- | --------------------------------- | ---------------------- |
| 设备端后台任务  | App 在没有可见视图的情况下运行声明过的任务       | 尽力而为；时机由系统决定     | 可以                              | 可以                   |
| 菜单栏项        | 宿主调用创建 `NSStatusItem`，菜单由数据驱动      | 不适用                       | 不适用                            | 可以                   |
| Live Activity   | glance 布局，由宿主调用或推送启动和更新          | 可以；数据 4 KB，最长 8 小时 | 只能用系统通知样式                | 未核实                 |
| 原生音视频      | 一个播放器原生组件；采集走宿主调用               | 可以；后台音频需在壳里声明   | 可以；需要前台服务                | 可以                   |
| 全屏            | 宿主调用隐藏壳的界面和系统栏                     | 可以；方向需在壳里声明       | 可以；大屏会忽略方向锁定          | 可以                   |
| 桌面小组件      | glance 布局；用户在小组件里选择 App              | 可以；尺寸固定，有刷新预算   | 可以                              | 可以（WidgetKit）      |
| 桌面图标        | 通过浏览器添加的快捷方式页面                     | 可以，用“添加到主屏幕”       | 可以；也可用 `requestPinShortcut` | 可以，用“添加到程序坞” |
| 入站 HTTP       | 宿主调用启动监听；请求以事件形式到达             | **只在前台**                 | 可以；需要前台服务                | 可以                   |
| Siri 和快捷指令 | 一个通用 intent“运行 App X 的某个动作”，参数动态 | 可以；intent 类型在壳里固定  | 可以（动态快捷方式）              | 可以                   |
| 闹钟            | 宿主调用负责安排、列出和取消                     | 可以（AlarmKit，iOS 26+）    | 可以（`AlarmManager`）            | 未核实                 |
| 健康数据        | 宿主调用读写声明过的类型                         | 可以；类型列表在壳里固定     | 可以（Health Connect，限制相同）  | 不适用                 |

各平台的单元格是 **[事实]**，来自 2026-11-22 阅读的 Apple 和 Android 文档；以下几点例外，它们是 **[假设]**，在做到对应能力时核实：Mac 能否自己发起 Live Activity、macOS 上是否有 AlarmKit、小组件扩展的内存上限（有人报告约 30 MB，文档里没有），以及桌面快捷方式能否不经点按就交给壳（A18）。说明：

- App 在服务端的入站 HTTP 已经存在（App webhook）。这里的能力是设备自己网络上的监听。
- 健康数据类型列表和小组件尺寸，在构建壳时要选得宽一些，因为以后再放宽需要发新壳。
- 能力集合是有版本的。App 包声明它需要的最低壳能力版本，较旧的壳会提示“请更新应用”。

### 3.9 独立打包

一个 App 变成一个独立的应用：同一个实例和后端、同一份壳代码，有自己的名字、图标和 bundle id，打开后直接进入这个 App，没有桌面、Dock 和侧栏。这不是跳进壳的快捷方式；App 运行在这个独立应用自己的进程里。

以单 App 模式启动的壳，用整个窗口显示一个 App，隐藏 App 切换，登录、更新和能力都和完整的壳一样。App 仍然从实例更新，不需要重新构建。

每个独立应用有自己的图标，为那个 App 单独制作：默认用 App 的图标，也可以为独立构建另外提供图稿，再渲染成各平台需要的图标集。

- **macOS [决定]。** 由桌面应用在用户的 Mac 上生成包装应用：一个很小的 `.app`，有自己的 Info.plist 和 bundle id，带 App 的图标（App 图标功能已经存在），还有一个启动器，以单 App 模式启动壳的二进制。它使用 ad-hoc 签名；在同一台 Mac 上创建的 bundle 不会被隔离，所以 Gatekeeper 不会拦它。要分享给另一台 Mac，需要用户自己用 Developer ID 签名并公证。能否沿用登录、能否显示通知，取决于 A14。
- **iOS [决定]。** 同一个 Expo 工程的变体构建。平台生成一份变体配置（实例地址、App id、名字、bundle id、图标）；构建在 Mac 上或 EAS 上进行，用部署者自己的 Apple 账号。平台从不持有签名证书，也从不替任何人签名，这是 Apple 的开发者协议所禁止的。分发方式是 TestFlight（构建 90 天后过期）或 ad hoc（每年 100 台设备）。依赖 A15。
- **Android。** 同样的变体做法，换一个 application id；排在 iOS 之后。

## 4. 数据库变更

- `apps`：增加 `activation_seq integer not null default 0`，在改变线上部署的同一个事务里递增。
- `deployments`：不加新列。运行时种类、NSH 运行时版本和声明的原生能力，从 `manifestNormalized.app` 里读取（`runtime`、`nshVersion`、`native`）。
- 新表 `app_native_grants`：`app_id`、`capability`、`params`（jsonb）、`granted_at`、`granted_by`（用户 id 或平台 Agent）。主键是 `(app_id, capability)`；行随 App 一起删除。
- 主题不加新表。`platformConfig` 里的 `ui.theme` 从 `{ accent }` 扩展为 `{ accent, mode, light, dark }`，其中 `light` 和 `dark` 各自是一个预设名，或者一份自定义主题文档。新字段都是可选的并带默认值（`mode: light`，两边都用预设），所以已存的行仍然有效；存下来的值无效时回退到 `desk`，和今天一样。
- 小组件和 Live Activity 的推送目标，存在现有的设备推送注册旁边。具体的列在第 7 阶段、A12 有结论时确定。

## 5. 平台 API、CLI 与 Platform/Runner 协议

公共 Connect RPC，任何有效凭证都可以调用：

- `AppService.GetAppPackage`（服务端流式返回字节，或一个签名的下载地址）和 `AppService.GetAppRuntimeTrust`（根公钥、吊销列表）。
- `AppService.ListNativeGrants`、`GrantNativeCapability`、`RevokeNativeCapability`。按仓库规则，用 Agent Run 凭证发起的授权会被接受，并记在平台 Agent 名下；第 9 节说明为什么这样是安全的。
- `AppService.GetStandaloneConfig` 返回某个 App 在某个平台上的变体配置。
- `ThemeService`（第 3 阶段）。`GetTheme` 还返回模式、浅色和深色主题，以及所请求外观下解析好的整套令牌。`SetTheme` 还接受模式，以及每种外观的预设名或自定义主题文档。新增 `ListThemePresets` 和 `ValidateTheme`（只检查一份文档，不保存）。事件 `theme.updated` 通知客户端重新读取主题。

`packages/hatch-cli` 里的 CLI，注册在 `commands.ts`：

- `hatch theme get [--resolved] [--json]`
- `hatch theme set`，可以带 `--accent <name>`、`--mode light|dark|system`，以及 `--appearance light|dark` 加上 `--preset <name>` 或 `--file <path|->` 二者之一。`--file` 替换该外观的整份自定义主题，`--preset` 清除它；两者都必须同时给出 `--appearance`，否则被拒绝。没有给出的参数对应的字段保持不变。主题被拒绝时，会指出不合格的键或那一对颜色。
- `hatch theme check --file <path|->`（只校验，不做任何改动）
- `hatch theme presets [--json]`
- `hatch theme reset`（回到 `desk`、浅色、默认强调色）
- `hatch app package <app> --out <path>`（下载线上的签名包）
- `hatch app get` 增加 `frontend.runtime`、`frontend.nshVersion`，以及声明的和已授予的原生能力。
- `hatch app grants <app> [--limit <n>] [--cursor <cursor>] [--json]`（打印下一个游标）
- `hatch app grant <app> --capability <id> [--param <key=value>]...`（整体替换该能力的参数）
- `hatch app revoke <app> --capability <id>`
- `hatch app standalone <app> --platform ios|android --out <dir>`（写出变体配置；不构建，也不签名）

Web 界面的设置和 CLI 调用同一个领域服务。

明确列出的 CLI 覆盖例外，每一项都绑定在设备上：

- 敏感能力的逐设备同意：这是设备用户在那台设备上的回答，和系统权限一样。
- 生成 Mac 包装应用：它要在用户的 Mac 上写入并签名一个 bundle，所以放在桌面应用里。
- 运行中的 App 列表及其布局：这是某一个壳窗口的状态，和浏览器里打开的标签页一样。
- 添加桌面快捷方式：只有设备用户能在浏览器里完成。快捷方式页面的链接和图标是有覆盖的：`hatch app get` 会打印链接，图标使用 App 图标的命令。

`docs/cli-tool-parity.md` 增加包、授权、主题和独立打包配置的条目，并列出这些例外。

Platform/Runner 协议：构建在平台服务器内进行，所以没有 REST 字段变化，`PROTOCOL_VERSION` 不变。

## 6. App 包契约与兼容性

- `app.runtime` 是可选的，默认 `web`；`app.native` 是可选的，默认没有任何能力。现有的 manifest 照常解析，所以这些是向后兼容的功能，**不**提升 `LATEST_APP_COMPATIBILITY_VERSION`。
- NSH 运行时是第二条独立的版本轴。平台固定一个 NSH 版本；每次部署记录它构建时用的版本；壳报告自己能运行的版本，平台拒绝把包交给运行不了它的壳，并提示“请更新应用”。
- 壳的能力集合是第三条轴，处理方式相同：由包声明，由壳报告，加载前检查。
- 升级固定的 NSH 版本是一次有意为之的变更，有自己的清单：阅读 NSH 的兼容性记录、重新构建 `@hatch/ui`、在所有壳上跑组件目录的截图测试、继续为用旧版本构建的部署提供旧的 Web 运行时。
- 在 `skills/app-compatibility/SKILL.md` 的 `Next (proposal)` 下记录：让 `native` 成为新 App 唯一的运行时。

## 7. 平台历史数据迁移

没有。每个 App 的 `activation_seq` 从 0 开始，只对 `native` 部署才会被读取。`app_native_grants` 一开始是空的。现有的行含义都不变。

## 8. 现有 App 的迁移

现有的 App 留在 `web`；源码、部署和数据都不动。把一个 App 迁到 `native`，就是由 Agent 重写它的前端，依据 `skills/building-apps` 里新增的一节；后端、proto 和数据原样沿用。在 `native` 部署之后回滚到 `web` 部署是可行的，因为运行时是按每次部署读取的。Web 上同时运行多个 App 也适用于现有的 `web` App，它们不需要任何改动。

## 9. 安全与权限

- 原生壳给每个 App 的授权恰好是 `{ host: [...] }`，其中包括 `hatch.rpc`、`hatch.data.*`、`hatch.theme.*`、`hatch.nav.*`，以及它被授予的能力对应的 `hatch.native.*` 名称。除此之外什么都没有：没有网络、剪贴板、文件或 URL 访问。宿主什么都不授予时，NSH 的默认行为是“App 声明什么就给什么”，所以授权是必须的，并有测试覆盖。
- 桥接的处理函数校验每个参数，并把每个请求限定在 App 自己的 id 上；`hatch.rpc` 只能访问 `/api/app/<该 id>/rpc`。
- 原生能力有两道门。实例级授权决定 App 能不能用某项能力。它遵循“每种凭证权限相同”的规则，所以 Agent Run 可以给它自己构建的 App 授予能力；授权会连同操作者一起记录，并显示在管理页上。第二道门不是凭证能通过的：敏感能力需要设备用户在壳里同意，按 App、按设备，再加上系统自己的权限。所以 Agent 可以准备好一个读取健康数据的 App，但在设备的用户在那台设备上同意之前，任何健康数据都不会离开设备。
- 原生组件对每个 App 都会注册，因为 NSH 要求在加载前注册，而且不对它们做管控。每个工厂自己执行授权检查；每个组件都有一个测试覆盖这一点。
- Web：信任模型不变。`native` App 在 Web 上对父页面的访问能力，和今天的 React App 一样，因为两者都运行在同源的 iframe 里。新的 CSP 收窄了网络访问。把 App 页面移到单独的源，记为后续工作，不属于本方案。Web 上不提供原生能力。
- 签名密钥永远不离开服务器；`GetAppRuntimeTrust` 只返回公开材料。密钥轮换：在同一把根密钥下签发新的发布密钥，重新签署线上的包；通过吊销列表吊销旧密钥。
- 独立应用持有的会话和完整的壳相同，在同样的授权下运行一个 App。变体配置里不含任何秘密。Apple 的签名材料留在部署者手里。
- `nsh` 二进制、重新打包工具和嵌入用的 SDK，都在 Dockerfile 以及 Mobile 和桌面端的构建里按版本和 SHA-256 固定。
- 部署时的启动检查会在平台服务器上运行 App 的前端代码。它使用生成的、不声明任何网络和文件访问的 `nsh.json`，使用只返回预置数据的桩宿主，并有时间限制；有一个测试覆盖“App 无法从这里访问网络或实例”。

## 10. 测试与验收

长期保留的测试：

- Manifest：`runtime` 和 `native` 的解析、默认值，以及对未知值的拒绝。
- 部署检查：每条规则一个用例（裸颜色、禁止的导入、流式 RPC、未知令牌），失败时给出文件和行号；默认模板能通过。
- 激活计数器：部署、部署、回滚，得到三个递增的构建号和三个能通过验证的包。
- 桥接：参数校验和跨 App 的范围限定，每个壳各一份。
- 能力授权：调用了未授权的宿主名称和外部 URL 的 App，在 iOS、Android 和 macOS 上都被拒绝。
- 原生授权：未授权的 `hatch.native.*` 调用和未授权的原生组件都被拒绝；被撤销的授权在下次加载时消失；授权命令的参数映射和输入拒绝。
- Glance 布局：同一棵树在每个解释器里都能渲染；过大或格式错误的树在到达扩展之前就被拒绝。
- 原生代码的边界：会话管理器、桥接、授权和原生能力所在的 Swift 包和 Kotlin 库，不引用 React Native 或 Expo；用一个构建检查覆盖。
- 会话管理器，在 Web 上和每个原生壳里：超出上限时回收最久没有显示过的 App，并在保存的路由上重新打开；打开运行中的 App 是切换焦点，而不是启动第二个副本；被隐藏的 App 收不到数据事件；新的部署给运行中的 App 打标记，而不是替换它。
- 运行中 App 之间的隔离：两个 App 在同一个壳里运行时，App A 读不到 App B 的存储，也不能通过桥接访问 B 的后端。
- 主题：`resolveTheme` 能从 `desk` 预设重现今天的令牌；低对比度的主题、未知的键、没有打包的字体，各自被拒绝并给出原因；已存的 `{ accent }` 行仍能加载；主题命令的参数映射和输入拒绝。
- 兼容性：`web` App 照常部署、提供服务和回滚。

验收在本地实例上进行。每个带界面变更的阶段都出一份验收报告。

| 标准             | 检查方式                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| 一份源码，四个壳 | 部署模板；在 Web、iOS、Android、macOS 上打开                                    |
| 换主题不重新部署 | `hatch theme set --accent teal` 让每个壳上已打开的 App 换色                     |
| 主题是数据       | `desk-dark` 和一份自定义主题文件，在 Web、Mobile 和 macOS 上，平台和 App 都检查 |
| 多个 App         | 在 Web、macOS 和平板上两个 App 并排；在手机上在五个 App 之间切换                |
| 回滚             | 回滚一个 `native` App；每个壳都加载到更旧的代码                                 |
| 目录被强制执行   | 带裸颜色的部署失败                                                              |
| 能力不需要发版   | 给一个新 App 授予一项能力；它在已经安装的壳上可用                               |
| 独立打包         | 生成 Mac 应用；构建 iOS 变体；两者都直接打开进入该 App                          |
| 现有 App         | 现有的 React App 在各处仍能打开                                                 |

每个新的 CLI 命令都要在 Agent Run 内和用户登录下各运行一遍。

## 11. 阶段划分、依赖与恢复

0. **第 0 阶段：验证。** A2、A3、A4、A5 和 A8 已完成（第 2 节），第 1 阶段只需要这些。其余假设在各自作为前提的阶段开始时解决。每次的产出：一份验证记录，每条假设给出可行或不可行。
1. **第 1 阶段：组件库与 Web。** 基于设计令牌的 `@hatch/ui` 目录、manifest 字段、构建和部署检查、`@hatch/app` 里的 `host.call` 传输层、Web 播放页、`AppSurface` 的消息通道、把强调色应用到原生 App、模板和 skill。可以单独交付：新 App 在 Web 上风格统一，并通过 Web 播放页在 Mobile 和 macOS 应用里运行。
2. **第 2 阶段：Web 上的多个 App。** Desk 外壳里的会话管理器，两种运行时都适用：保活、上限和回收、窗口并排、“有更新”。消息通道完成后，它不再依赖第 1 阶段。
3. **第 3 阶段：主题数据。** `resolveTheme` 以及 `desk` 和 `desk-dark` 预设、扩展后的 `ui.theme`、RPC 和 CLI、外观设置页，以及 Web、Mobile 和 macOS 上的运行时主题。不依赖第 1、2 阶段；原生 App 不需要额外工作就会跟随。
4. **第 4 阶段：包。** 签名、激活计数器、包和信任的 RPC，以及包的 CLI。Web 播放页用不到这些；原生壳需要。
5. **第 5 阶段：iOS 和 Android。** 先验证 A1、A6、A9、A17，并按 3.6 节的宿主决策点决定留在 Expo 还是换成原生薄壳。然后是不依赖 React Native 的会话管理器、桥接和授权，Expo 模块（或原生薄壳）把它们接进应用，最后是两栏布局。依赖第 4 阶段。
6. **第 6 阶段：macOS 原生视图。** Rust 的会话管理器和覆盖在 `AppSurface` 之上的原生视图，然后是分栏和独立窗口。依赖第 4 阶段和 A11。
7. **第 7 阶段：原生能力。** 分批进行，每一批都可以单独交付：
   1. 授权框架（manifest、表、RPC、CLI、管理页、设备上的同意）、服务端推送、设备端后台任务（A13），以及 glance 布局连同桌面小组件和 Live Activity（A12）；
   2. 全屏、原生音视频、菜单栏项、闹钟、Siri 和快捷指令（A16）；
   3. 健康数据、设备上的 HTTP 服务和桌面快捷方式（A18）。
8. **第 8 阶段：独立打包。** 壳的单 App 模式、Mac 包装应用生成器（A14），然后是 iOS 的变体配置和构建（A15），再然后是 Android。
9. **不排期：以后另立方案。** 桌面小组件迁到原生运行时、可视化的主题编辑器、Windows 和 Linux、App 页面使用单独的源；Mobile 的平台界面改用 NSH 来写（在宿主决策点和 A19 之后）。

恢复：每个阶段都是增量的，由 `app.runtime` 或授权来控制开关。把默认模板改回 `web`，就不会再有新的原生 App，已部署的不受影响。NSH 升级出问题时，固定回上一个版本即可；旧的 Web 运行时会继续提供。撤销授权不需要部署就能关掉一项能力，`hatch theme reset` 可以回到内置的外观。没有不可逆的步骤；新增的持久状态只有签名密钥、`activation_seq`、授权和主题设置。

## 12. 文档、Skill、提示词与模板

- `skills/building-apps/SKILL.md`：`native` 的工作流程、验证命令和迁移一节；`references/frontend-widgets.md` 拆成 Web 和原生两部分；新增 `references/design-system.md`；从第 7 阶段起新增 `references/native-capabilities.md`（每项能力做什么、如何声明，以及它需要授权）。
- `skills/importing-apps`：导入的 React App 保持 `web`。
- `templates/default-app`：使用 `@hatch/ui` 的 `native` 前端；小组件不变。
- 系统提示词（`src/agent/system-prompt.ts`）：加一行，说明默认运行时并指向设计规范。
- `DESIGN.md`：已经是令牌和组件规格的来源；补充 App 一侧的说明（`AppShell` 按面板宽度的行为、glance 布局）、主题文档、推导规则和深色预设。`src/ui/theme/README.md` 和 `mobile/AGENTS.md` 按运行时主题更新。
- `docs/`：`cli-tool-parity.md`；新增 `app-native-runtime.md`（面向壳的作者的包、桥接、能力和信任契约）；`mobile-workspace.md`；`desktop/README.md` 补充原生视图和包装应用生成器。
- `README.md` 的改动按仓库规则另行提出、单独确认。
