# π-graph Run Viewer

单文件交互式 Agent 执行图查看器：`index.html`；另附零依赖本地服务器 `server.mjs`，支持实时轮询运行中的 run。

## 使用

### file:// 直开（demo / 手动选文件）

- 直接双击 `index.html`（file:// 协议）即可打开，无需构建、无需本地服务器，页面自动渲染内置 demo（`review-smoke-20260722-r1`，3 节点 fan-out/fan-in）。
- 点击「选择 run 文件…」可多选真实 run 目录下的 `snapshot.json` / `events.jsonl` / `graph.json`（按内容自动识别，可只选其中一部分；无 `graph.json` 时依赖边与 agent 信息缺失，其余正常）。

### Live 模式（http://127.0.0.1:7474/）

```bash
node docs/viewer/server.mjs            # 默认端口 7474，runs 根 ~/.pi/agent/graph-runs
PORT=8000 node docs/viewer/server.mjs  # 覆盖端口
GRAPH_RUNS_DIR=/path/to/runs node docs/viewer/server.mjs  # 覆盖 runs 根目录
```

浏览器打开 `http://127.0.0.1:7474/`：

- 默认仍渲染内置 demo；顶栏多出 run 下拉、「Live」开关与「刷新」按钮。
- 在下拉中选择一个 run 即拉取其 `snapshot.json` / `events.jsonl` / `graph.json` 并渲染；run 处于 running/queued 或有节点处于进行中状态时，顶栏显示「运行中」提示。
- 打开「Live」后每 1.5s 自动重新拉取当前 run 并**增量重绘**（复用 DAG/时间轴实例，事件流只追加新事件并滚动到最新，时间轴窗口跟随最新事件平移；数据无变化时跳过重绘）。「刷新」按钮立即手动拉取一次。
- 点击「载入内置 Demo」或「选择 run 文件…」会自动关闭 Live。

服务器端点（仅绑定 127.0.0.1，run id 白名单校验防目录穿越）：

| 端点 | 说明 |
| --- | --- |
| `GET /` | 返回 `index.html` |
| `GET /api/runs` | `{ runs: [{ id, status, updatedAt, goal }] }`，按 updatedAt 倒序 |
| `GET /api/runs/:id/snapshot` | 该 run 的 `snapshot.json` 原文 |
| `GET /api/runs/:id/events` | 该 run 的 `events.jsonl` 原文（text/plain） |
| `GET /api/runs/:id/graph` | 该 run 的 `graph.json` 原文（不存在则 404，viewer 自动降级） |

- 图可视化通过 CDN 加载 vis-network / vis-timeline；离线时页面顶部显示降级提示，事件流与节点详情仍可用。

## 功能

- DAG 拓扑：状态着色（与 `docs/graph-architecture.md` 状态语义一致），依赖边方向为 依赖 → 被依赖；进行中节点脉冲高亮。
- Attempt 阶段时间轴：由 `node.*` 事件推导 leased → dispatching → running → collecting → verifying → accepted 各阶段区间；无事件时回退到 attempts 的 startedAt/endedAt。
- 事件流列表：点击 `node.*` 事件联动定位并选中对应节点。
- 节点详情面板：agent、sideEffect、dependsOn、retryPolicy、attempts 表格（起止时间、耗时、workspace、outputPath）、error/failure。

## 内置 demo 数据来源

`~/.pi/agent/graph-runs/review-smoke-20260722-r1/` 的 `graph.json`、`snapshot.json`、`events.jsonl` 原文内嵌。
