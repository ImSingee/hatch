# Example notifications

Every card of the timeline and action-card designs, three free-form cards
and one Markdown notification, each with its summary. They are in the
designs' language (Chinese); write your own in the language the user uses.
Copy the closest one, change it, and run `hatch notification card check`.
The designs' Workflow examples are App scheduled tasks here.

### Stats (`digest`)

Reproduces the design's "Stats" card (a Workflow digest in the design; the figures now count App scheduled task runs). Source `Agent`, kind `每日摘要`.

Summary: `过去 24 小时一切正常`

```xml
<Card icon="chart">
  <Title>过去 24 小时的平台概况</Title>
  <Text>一切正常。耗时最长的是「同步订单」，跑了 4 分 31 秒，比平时慢了大约 1 分钟。</Text>
  <Grid columns="3">
    <Stat value="12" label="定时任务运行" />
    <Stat value="3" label="次部署" />
    <Stat value="0" label="失败" />
  </Grid>
</Card>
```

### Fields (`deploy`)

Reproduces the design's "Fields" card. Source `记账本`, kind `部署`.

Summary: `v12 已部署到生产`

```xml
<Card icon="app" status="已上线" tone="success">
  <Title>v12 已部署到生产</Title>
  <Text>这次部署包含 2 个改动，数据迁移已完成，旧版本的实例已经停掉。</Text>
  <Fields>
    <Field label="版本">v12</Field>
    <Field label="耗时">48 秒</Field>
    <Field label="实例">2 个运行中</Field>
  </Fields>
</Card>
```

### Steps (`task`)

Reproduces the design's "Steps" card. Source `Agent`, kind `任务`.

Summary: `「记账本」存储迁移进行中`

```xml
<Card icon="agent" status="进行中" tone="working">
  <Title>把「记账本」迁移到新的存储 API</Title>
  <Text>迁移脚本已生成，正在预览环境里验证。</Text>
  <Steps>
    <Step state="done" detail="09:41">读取现有 schema</Step>
    <Step state="done" detail="09:52">生成迁移脚本</Step>
    <Step state="running" detail="进行中">在预览环境验证</Step>
    <Step>部署到生产</Step>
  </Steps>
</Card>
```

### Steps, updated (`task-done`)

Reproduces the design's "Steps, updated" card. Source `Agent`, kind `任务`.

Summary: `「记账本」已迁移到新的存储 API`

```xml
<Card icon="agent" status="已完成" tone="success">
  <Title>把「记账本」迁移到新的存储 API</Title>
  <Text>迁移完成，「记账本」现在跑在新的存储 API 上，旧数据全部保留。</Text>
  <Steps>
    <Step state="done" detail="09:41">读取现有 schema</Step>
    <Step state="done" detail="09:52">生成迁移脚本</Step>
    <Step state="done" detail="10:27">在预览环境验证</Step>
    <Step state="done" detail="10:54">部署到生产</Step>
  </Steps>
</Card>
```

### Progress (`pr261-running`)

Reproduces the design's "Progress" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 的 CI 正在运行`

```xml
<Card icon="pr" status="CI 运行中" tone="info">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>已推送 2 个提交，检查正在运行。</Text>
  <Fields>
    <Field label="分支" mono>fix/patch-body-framing</Field>
  </Fields>
  <Progress label="检查" value="3 / 14" percent="21" tone="info" />
</Card>
```

### Checks with actions (`pr261-failed`)

Reproduces the design's "Checks with actions" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 的 CI 失败了，等你处理`

```xml
<Card icon="pr" status="CI 失败" tone="danger">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>14 项检查里有 2 项失败，都是 <code>src/agent/runtime.test.ts</code> 里的 5 秒超时。</Text>
  <Steps mono>
    <Step state="done" detail="41 秒">check:types</Step>
    <Step state="done" detail="18 秒">lint</Step>
    <Step state="failed" detail="2 个用例超时">test:unit</Step>
    <Step state="done" detail="3 分 02 秒">test:browser</Step>
  </Steps>
  <Fields>
    <Field label="其余">10 项通过</Field>
  </Fields>
  <Buttons id="next">
    <Button id="fix" primary then-status="修复中" then-tone="working">修复它</Button>
    <Button id="skip">先不管</Button>
  </Buttons>
</Card>
```

### Primary and secondary buttons (`pr261-passed`)

Reproduces the design's "Primary and secondary buttons" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 可以合并了`

```xml
<Card icon="pr" status="CI 通过" tone="success">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>14 项检查全部通过，已有 1 个 Approve，没有冲突，可以合并。</Text>
  <Fields>
    <Field label="分支" mono>fix/patch-body-framing</Field>
    <Field label="评审">1 Approve</Field>
  </Fields>
  <Progress label="检查" value="14 / 14" percent="100" tone="success" />
  <Buttons id="merge">
    <Button id="merge" primary then-status="合并中" then-tone="working">Merge</Button>
    <Button id="wait">先不合并</Button>
  </Buttons>
</Card>
```

### Updated card (`pr261-merged`)

Reproduces the design's "Updated card" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 已合并`

```xml
<Card icon="pr" status="已合并">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>已 squash 合并到 master，分支已删除。</Text>
</Card>
```

### Log excerpt with urgent flag (`sync-failed`)

Reproduces the design's "Log excerpt with urgent flag" card (a Workflow failure in the design; an App scheduled task here). Source `同步订单`, kind `定时任务`.

Summary: `定时任务「同步订单」第 3 步失败`

```xml
<Card icon="task" status="运行失败" tone="danger" flag="紧急">
  <Title>第 3 步「写入数据库」失败</Title>
  <Text>已自动重试 2 次，都停在同一步。上游数据里有重复的订单号。</Text>
  <Code>step 3/5  write_orders
error: duplicate key value violates unique constraint "orders_pkey"
  detail: Key (id)=(ord_8841) already exists.
  at insertBatch (sync-orders.ts:88)</Code>
  <Buttons id="next">
    <Button id="investigate" primary then-status="排查中" then-tone="working">让 Agent 排查</Button>
    <Button id="retry" then-status="重试中" then-tone="info">直接重试</Button>
    <Button id="ignore">忽略</Button>
  </Buttons>
</Card>
```

### Quote, text input or buttons (`pr258`)

Reproduces the design's "Quote, text input or buttons" card. Source `hatch`, kind `PR #258`.

Summary: `PR #258 有 1 条新评审意见`

```xml
<Card icon="pr" status="有新评审" tone="warning">
  <Title>Stop idle serverless app backends</Title>
  <Text>Bryan 留了 1 条需要处理的评审意见。</Text>
  <Quote author="Bryan" location="idle-shutdown.ts:142">这里的等待没有上限，实例卡住的话会一直等下去。</Quote>
  <Input id="how" label="告诉 Agent 怎么改（可选）" placeholder="例如：上限设 30 秒，超时后强制停止" multiline />
  <Row justify="between" wrap>
    <Button href="https://github.com/ImSingee/hatch/pull/258">查看 PR</Button>
    <Buttons id="next">
      <Button id="later">稍后处理</Button>
      <Button id="fix" primary then-status="修复中" then-tone="working">修复它</Button>
    </Buttons>
  </Row>
</Card>
```

### Usage progress (`usage`)

Reproduces the design's "Usage progress" card. Source `平台`, kind `用量`.

Summary: `本月 Agent 用量已到 82%`

```xml
<Card icon="chart" status="接近上限" tone="warning">
  <Title>本月 Agent 用量已到 82%</Title>
  <Text>按最近 7 天的速度，大约在 24 号用完。用完后新的 Agent Run 会排队到下月。</Text>
  <Progress label="已用" value="82%" percent="82" tone="warning" />
  <Buttons id="next">
    <Button id="light" primary then-status="已调整" then-tone="success">后台任务改用轻量模型</Button>
    <Button id="ok">知道了</Button>
  </Buttons>
</Card>
```

### Title and body only (`remind`)

Reproduces the design's "Title and body only" card. Source `提醒`, kind `会议`.

Summary: `15 分钟后和 Bryan 过 serverless 方案`

```xml
<Card icon="clock">
  <Title>15 分钟后：和 Bryan 过一遍 serverless 方案</Title>
  <Text>你昨天让我在会前提醒你。相关的 PR #258 还有 1 条评审意见没处理。</Text>
  <Buttons id="next">
    <Button id="snooze" then-status="已推迟">10 分钟后再提醒</Button>
    <Button id="ok">知道了</Button>
  </Buttons>
</Card>
```

### Buttons (`perm`)

Reproduces the design's "Buttons" card. Source `Agent`, kind `权限申请`.

Summary: `「记账本」想访问 api.exchangerate.host`

```xml
<Card icon="shield" status="等你批准" tone="warning">
  <Title>允许「记账本」访问外部网络</Title>
  <Text>迁移脚本需要从 <code>api.exchangerate.host</code> 拉取汇率。只放行这一个域名，不影响其它网络策略。</Text>
  <Fields>
    <Field label="域名" mono>api.exchangerate.host</Field>
    <Field label="方向">仅出站 HTTPS</Field>
    <Field label="有效期">永久，可随时撤销</Field>
  </Fields>
  <Buttons id="decision">
    <Button id="allow" primary then-status="已批准" then-tone="success">允许</Button>
    <Button id="once" then-status="已批准一次" then-tone="success">只允许这一次</Button>
    <Button id="deny" destructive then-status="已拒绝">拒绝</Button>
  </Buttons>
</Card>
```

### Single choice (`alert`)

Reproduces the design's "Single choice" card. Source `记账本`, kind `告警`.

Summary: `记账本后端 10 分钟内重启了 3 次`

```xml
<Card icon="app" status="异常" tone="danger" flag="紧急">
  <Title>后端实例 10 分钟内重启了 3 次</Title>
  <Text>每次都是内存超过上限后被终止，从 v12 上线后开始出现。</Text>
  <Progress label="内存峰值" value="498 / 512 MB" percent="97" tone="danger" />
  <Choice id="plan" label="要怎么处理？" required>
    <Option id="rollback" note="约 1 分钟" then-status="回滚中" then-tone="working">回滚到 v11</Option>
    <Option id="raise" note="立即生效" then-status="调整中" then-tone="working">把内存上限提到 1 GB</Option>
    <Option id="dig" then-status="排查中" then-tone="working">保持现状，让 Agent 排查</Option>
  </Choice>
  <Row justify="end">
    <Submit>确认</Submit>
  </Row>
</Card>
```

### Multiple choice (`deps`)

Reproduces the design's "Multiple choice" card. Source `Agent`, kind `依赖更新`.

Summary: `有 4 个依赖可以升级`

```xml
<Card icon="package" status="等你选择" tone="warning">
  <Title>有 4 个依赖可以升级</Title>
  <Text>补丁版本我已经跑过测试。标了「破坏性」的那个需要单独迁移，默认没有勾选。</Text>
  <Choice id="upgrade" label="选择要升级的依赖" multiple required>
    <Option id="mantine" badge="补丁" default>@mantine/core</Option>
    <Option id="vitest" badge="补丁" default>vitest</Option>
    <Option id="zod" badge="补丁" default>zod</Option>
    <Option id="drizzle" badge="破坏性">drizzle-orm</Option>
  </Choice>
  <Submit>升级选中的</Submit>
</Card>
```

### Free-form: spending overview (`spending`)

A free-form card that is not in the designs: spending overview. Source `记账本`, kind `月度账单`.

Summary: `本月支出 ¥3,482，超出预算 12%`

```xml
<Card icon="money" status="超支" tone="warning">
  <Row justify="between" align="end">
    <Column gap="xs">
      <Text size="xl" weight="bold">¥3,482</Text>
      <Caption>本月支出</Caption>
    </Column>
    <Badge tone="danger">+12% 环比</Badge>
  </Row>
  <Trend values="210,180,260,240,390,410,520" threshold="400" unit="¥" label="最近 7 天" />
  <Divider />
  <Grid columns="3">
    <Stat value="¥1,204" label="餐饮" />
    <Stat value="¥980" label="交通" />
    <Stat value="¥1,298" label="其它" />
  </Grid>
</Card>
```

### Free-form: release comparison (`release`)

A free-form card that is not in the designs: release comparison. Source `记账本`, kind `发布`.

Summary: `v12 已上线，冷启动快了一倍`

```xml
<Card icon="deploy" status="已上线" tone="success">
  <Title>v12 与 v11 对比</Title>
  <Table>
    <Tr><Th>指标</Th><Th>v11</Th><Th>v12</Th></Tr>
    <Tr><Td>冷启动</Td><Td>2.1 s</Td><Td><b>0.9 s</b></Td></Tr>
    <Tr><Td>内存峰值</Td><Td>498 MB</Td><Td><b>301 MB</b></Td></Tr>
  </Table>
  <Callout tone="info" title="空闲 5 分钟自动休眠">第一次请求会多等约 1 秒。</Callout>
  <Collapse summary="查看 3 项改动">
    <List>
      <Item>修复登录重定向</Item>
      <Item>后端改用 serverless 模式</Item>
      <Item>空闲 5 分钟自动休眠</Item>
    </List>
  </Collapse>
</Card>
```

### Free-form: incident timeline (`incident`)

A free-form card that is not in the designs: incident timeline. Source `订单`, kind `事故`.

Summary: `订单同步中断，约 40 笔订单延迟`

```xml
<Card icon="alert" status="处理中" tone="working">
  <Title>订单同步中断</Title>
  <Box surface="muted">
    <Fields>
      <Field label="影响">约 40 笔订单延迟</Field>
      <Field label="开始"><time datetime="2026-11-25T02:14:00Z" /></Field>
    </Fields>
  </Box>
  <Steps>
    <Step state="done" at="2026-11-25T02:14:00Z">发现重复订单号</Step>
    <Step state="done" at="2026-11-25T02:20:00Z">暂停写入</Step>
    <Step state="running">按订单号改为 upsert</Step>
    <Step state="pending">补写延迟的订单</Step>
  </Steps>
  <Text size="sm" tone="dimmed"><a href="hatch://app/orders#/manage">打开订单 App</a></Text>
</Card>
```

### Markdown (`release-notes`)

A Markdown notification with a heading, inline code, a list, a table and a link. Source `发布助手`, kind `发布`.

Summary: `v12 已发布到生产`

```text
## v12 发布说明

后端改用 `serverless` 模式。

- 修复登录重定向
- 空闲 5 分钟自动休眠

| 指标 | v11 | v12 |
| --- | --- | --- |
| 冷启动 | 2.1 s | 0.9 s |

[完整变更记录](https://github.com/ImSingee/hatch/releases)
```
