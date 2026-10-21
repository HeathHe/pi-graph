import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { TodoController, TODO_ENTRY } = await jiti.import<any>("../src/v3/ui/todo.ts");
const { buildTodoTree } = await jiti.import<any>("../src/v3/ui/todo-tree.ts");
const { registerGraphTodo } = await jiti.import<any>("../extensions/graph-todo.ts");
const deepFreeze = (value: any): any => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

test("independent seven-leaf native record read projects healthy wait, real failure and wrong-run risk without writes", async () => {
 const leaf = (id: string, parentId: string, extra = {}) => ({ id, title: "核对任务 " + id, status: "pending", links: [], parentId, ...extra });
 const link = (taskId: string) => ({ graphId: "review-graph", runInstanceId: "review-run", taskId });
 const rows = [
  { id: "conditions", title: "核对条件", status: "pending", links: [] },
  leaf("history", "conditions", { links: [link("accepted")] }),
  leaf("source", "conditions", { status: "done", assignee: "parent" }),
  leaf("contract", "conditions", { links: [link("active")] }),
  { id: "implementation", title: "实施接入", status: "pending", links: [] },
  leaf("config", "implementation", { dependsOn: ["contract"] }),
  leaf("implement", "implementation", { dependsOn: ["config"] }),
  { id: "delivery", title: "验证交付", status: "pending", links: [] },
  leaf("verify", "delivery", { dependsOn: ["implement"] }),
  leaf("review", "delivery", { dependsOn: ["verify"] }),
 ];
 const record = deepFreeze({ id: "record", type: "custom", customType: TODO_ENTRY, data: { version: 1, revision: 3, updatedAt: "2026-10-19T00:00:00Z", planId: "review-plan", goal: "完成登录接入", items: rows } });
 const entries = deepFreeze([record]), before = JSON.stringify(entries);
 const manager = { getSessionId: () => "owner", getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries };
 const controller = new TodoController(); controller.activate(manager);
 let phase = "running", runId = "review-run", appends = 0, graphActions = 0, publishes = 0, tool: any;
 registerGraphTodo({
  registerTool(value: any) { tool = value; },
  appendEntry() { appends++; throw new Error("readonly list attempted append"); },
  events: { on() { graphActions++; }, emit() { graphActions++; throw new Error("readonly list attempted Graph action"); } },
 } as any, {
  controller,
  async read() { return { graphId: "review-graph", runInstanceId: runId, sessionId: "owner", status: phase === "failed" ? "failed" : "running", nodes: { accepted: { phase: "accepted", attempt: 1 }, active: { phase, attempt: 1 } } }; },
  changed() { publishes++; },
 });
 const list = async () => (await tool.execute("readonly", { action: "list" }, undefined, undefined, { sessionManager: manager })).details;
 const view = await list(), tree = buildTodoTree(view.items);
 assert.equal(tree.groupIds.size, 3); assert.equal(tree.leafIds.length, 7);
 const leaves = tree.leafIds.map((id: string) => view.items.find((item: any) => item.id === id));
 assert.equal(leaves.filter((item: any) => item.derivedStatus === "done").length, 2);
 assert.equal(leaves.filter((item: any) => item.derivedStatus === "in_progress").length, 1);
 const groups = view.items.filter((item: any) => tree.groupIds.has(item.id));
 assert.deepEqual(groups.map((item: any) => item.rollup.total), [3, 2, 2]);
 assert.deepEqual(groups.map((item: any) => item.rollup.blocked), [0, 0, 0]);
 assert.equal(groups.reduce((sum: number, item: any) => sum + item.rollup.waiting, 0), 4);
 assert.equal(groups.reduce((sum: number, item: any) => sum + item.rollup.manualDone, 0), 1);
 assert.ok(groups.every((item: any) => item.source === "分组汇总" && !item.links.length && item.status === "pending"));
 assert.deepEqual(groups.map((item: any) => item.derivedStatus), ["in_progress", "pending", "pending"]);
 assert.equal(view.goal, "完成登录接入"); assert.equal(view.revision, 3);
 phase = "failed";
 const failed = await list();
 assert.ok(failed.items.filter((item: any) => tree.groupIds.has(item.id)).every((item: any) => item.derivedStatus === "blocked"));
 assert.deepEqual(failed.items.filter((item: any) => tree.groupIds.has(item.id)).map((item: any) => item.rollup.blocked), [1, 2, 2]);
 runId = "another-run";
 const unknown = await list();
 assert.equal(unknown.items.find((item: any) => item.id === "conditions").derivedStatus, "unknown");
 assert.equal(unknown.items.find((item: any) => item.id === "contract").derivedStatus, "unknown");
 assert.match(unknown.items.find((item: any) => item.id === "contract").reason, /运行实例已变化/);
 assert.equal(JSON.stringify(entries), before);
 assert.equal(appends, 0); assert.equal(graphActions, 0); assert.equal(publishes, 3);
});


test("independent Inspector fold/completion toggles, details and stale refresh stay read-only", async () => {
 const { PlanInspector } = await jiti.import<any>("../src/v3/ui/plan-inspector.ts");
 const first: any = { planId: "first", revision: 1, persistence: "memory", items: [
  { id: "g", title: "阶段", status: "pending", derivedStatus: "in_progress", source: "分组汇总", links: [] },
  { id: "leaf", parentId: "g", title: "待做事项", status: "pending", derivedStatus: "in_progress", source: "人工", links: [] },
 ] };
 deepFreeze(first); const before = JSON.stringify(first);
 let next: any = first, changed = 0, closed = 0;
 const folds = new Set<string>(), completed = new Set<string>(), selection: { id?: string } = {};
 const panel = new PlanInspector({ view: first, selection, theme: { fg: (_: string, text: string) => text }, rows: () => 24,
  requestRender() { changed++; }, close() { closed++; }, navigate() { throw new Error("unexpected navigation"); },
  openLink() { throw new Error("no link may open or start"); }, history() { throw new Error("unexpected Graph history"); }, read: async () => next,
  getFoldedIds: () => folds, toggleGroup(id: string) { folds.has(id) ? folds.delete(id) : folds.add(id); },
  getExpandedCompleted: () => completed, toggleCompleted(id: string) { completed.has(id) ? completed.delete(id) : completed.add(id); },
 });
 try {
  assert.match(panel.render(80).join("\n"), /#1\.1/);
  panel.handleInput("\x1b[D"); assert.deepEqual([...folds], ["g"]); assert.doesNotMatch(panel.render(80).join(""), /待做事项/);
  panel.handleInput("c"); assert.deepEqual([...completed], [],"c is local to this Inspector");
  panel.handleInput("\x1b[C"); panel.handleInput("\x1b[B"); assert.equal(selection.id, "leaf");
  panel.handleInput("\r"); assert.match(panel.render(80).join(""), /总计划详情/);
  panel.handleInput("\x1b"); assert.equal(selection.id, "leaf");
  next = { planId: "second", revision: 2, persistence: "memory", items: [{ id: "replacement", title: "新叶", status: "pending", derivedStatus: "pending", source: "人工", links: [] }] };
  await panel.refresh(); assert.equal(selection.id, "replacement"); assert.doesNotThrow(() => panel.render(45));
  next = { ...next, items: [] }; await panel.refresh(); assert.equal(selection.id, undefined);
  for (const key of ["\x1b[A", "\x1b[B", "c", "\r", "\x1b"]) assert.doesNotThrow(() => { panel.handleInput(key); panel.render(45); });
  assert.equal(closed, 0); assert.ok(changed > 0); assert.equal(JSON.stringify(first), before);
 } finally { panel.dispose(); }
});

test("independent actual host viewport keeps native draft, width budget and full title before observed identity", async () => {
 const { piCliIdentity } = await import("./helpers/pi-cli.ts");
 const { resolveHostDependencyRoot } = await import("../src/runtime/host-sdk.ts");
 const { pathToFileURL } = await import("node:url"), { join } = await import("node:path");
 const sdkRoot = piCliIdentity.root;
 const alias: Record<string, string> = { "@earendil-works/pi-coding-agent": join(sdkRoot, "dist/index.js") };
 for (const name of ["pi-tui", "pi-ai", "pi-agent-core"]) alias["@earendil-works/" + name] = join(await resolveHostDependencyRoot(sdkRoot, "@earendil-works/" + name), "dist/index.js");
 const native = createJiti(import.meta.url, { alias, moduleCache: false });
 const { terminalStack } = await native.import<any>("../src/v3/ui/terminal-stack.ts");
 const { projectTodo } = await native.import<any>("../src/v3/ui/todo.ts");
 const { Editor, Text, Container, TuiMainScreen, visibleWidth } = await native.import<any>("@earendil-works/pi-tui");
 const themes = await native.import<any>(pathToFileURL(join(sdkRoot, "dist/modes/interactive/theme/theme.js")).href);
 const { createChatViewport } = await native.import<any>(pathToFileURL(join(sdkRoot, "dist/modes/interactive/chat-viewport.js")).href);
 const tuiRoot = await resolveHostDependencyRoot(sdkRoot, "@earendil-works/pi-tui");
 const { renderLayoutFrame } = await native.import<any>(pathToFileURL(join(tuiRoot, "dist/layout.js")).href);
 const snapshot = deepFreeze({ sessionId: "owner", graphId: "graph", runInstanceId: "run", status: "running", updatedAt: "2026-10-19T00:00:00Z", nodes: {
  run: { phase: "running", attempt: 1, agent: "review-agent", dependsOn: [], observation: { asyncId: "offline-native", actualAgent: "review-agent", actualModel: "offline/actual-model" } },
 } });
 const items = deepFreeze([{ id: "g", title: "接入核查", status: "pending", links: [] }, { id: "work", parentId: "g", title: "确认登录契约与筛选条件，检查查询和重置结果", status: "pending", links: [{ graphId: "graph", runInstanceId: "run", taskId: "run" }] }]);
 const plan = { planId: "native-review", revision: 1, goal: "核对接入", persistence: "memory", items: await projectTodo(items, "owner", async () => snapshot) };
 const input: any = deepFreeze({ sessionId: "owner", snapshots: [snapshot], plan, expanded: true, reservedRows: 7 });
 const before = JSON.stringify(input), draft = "未发送草稿\n第二行保持"; let frames = 0;
 for (const palette of ["dark", "light"]) for (const width of [45, 120]) for (const height of [8, 24]) {
  themes.initTheme(palette, false);
  const screen = new TuiMainScreen({ columns: width, rows: height, write() {}, hideCursor() {}, showCursor() {} }); screen.requestRender = () => {};
  const editor = new Editor(screen, themes.getEditorTheme()); editor.setText(draft);
  const above = new Container(), below = new Container();
  const rows = terminalStack(input, width, height, themes.theme);
  assert.ok(rows.todo.length + rows.agents.length <= height - 7);
  assert.ok([...rows.todo, ...rows.agents].every((line: string) => visibleWidth(line) < width));
  above.addChild({ render: () => rows.todo, invalidate() {} }); below.addChild({ render: () => rows.agents, invalidate() {} });
  const viewport = createChatViewport({ document: new Text("当前对话", 0, 0), pendingMessages: new Text("", 0, 0), status: new Text("状态", 0, 0), widgetsAbove: above, editor, widgetsBelow: below, footer: new Text("项目\n模型", 0, 0) });
  const frame = renderLayoutFrame(viewport.root, width, height, () => {});
  assert.equal(frame.lines.length, height); assert.ok(frame.lines.every((line: string) => visibleWidth(line) <= width));
  assert.equal(editor.getText(), draft); assert.equal(JSON.stringify(input), before);
  if (height === 24) {
   const plain = rows.todo.map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
   const identity = plain.findIndex((line: string) => line.includes("@review-agent"));
   assert.ok(identity > 0); assert.match(plain.slice(0, identity+1).join("").split("@review-agent")[0], /重置结果/); const laterIdentity=plain.findLastIndex((line:string)=>line.includes("@review-agent"));assert.ok(laterIdentity>=identity);if(laterIdentity>identity)assert.match(plain.slice(identity+1,laterIdentity+1).join("").split("@review-agent")[0],/重置结果/);
   assert.ok(frame.lines.join("").includes("未发送草稿"));
  }
  frames++;
 }
 assert.equal(frames, 8);
});


test("independent completion focus keeps all-leaf counts, recent rows and a completed warning visible", async () => {
 const { terminalStack } = await jiti.import<any>("../src/v3/ui/terminal-stack.ts");
 const theme = { fg: (_: string, text: string) => text };
 const done = Array.from({ length: 10 }, (_, i) => ({ id: "done" + i, title: "历史完成项" + i, status: "done", derivedStatus: "done", source: "人工", links: [] }));
 const work = { id: "active", title: "当前必须处理", status: "in_progress", derivedStatus: "in_progress", source: "人工", links: [], assignee: "parent" };
 const input: any = { sessionId: "owner", snapshots: [], expanded: true, plan: { planId: "focus-review", revision: 1, goal: "当前目标", persistence: "memory", items: [...done, work] } };
 const before = JSON.stringify(input);
 let text = terminalStack(input, 120, 24, theme).todo.join("\n");
 assert.match(text, /10\/11/); assert.match(text, /当前必须处理/); assert.match(text, /历史完成项0/);
 text = terminalStack({ ...input, recentCompletedIds: ["done8", "done9"] }, 120, 24, theme).todo.join("\n");
 assert.match(text, /历史完成项8/); assert.match(text, /历史完成项9/); assert.match(text, /历史完成项0/); assert.match(text, /当前必须处理/); assert.match(text, /10\/11/);
 const complete = structuredClone(input); complete.plan.items[10] = { ...work, status: "done", derivedStatus: "done" };
 const summary = terminalStack(complete, 120, 24, theme).todo;
 assert.ok(summary.length>1); assert.match(summary[0], /11\/11/); assert.match(summary[0], /Alt\+T/);
 const risk = structuredClone(complete);
 risk.plan.items[0] = { ...risk.plan.items[0], source: "Graph验收", links: [{ graphId: "warning-graph", runInstanceId: "warning-run", taskId: "finished" }] };
 risk.snapshots = [{ sessionId: "owner", graphId: "warning-graph", runInstanceId: "warning-run", status: "complete", updatedAt: "2026-10-19T00:00:00Z", nodes: { finished: { phase: "accepted", attempt: 1, agent: "reviewer", dependsOn: [], observation: { asyncId: "warning", actualAgent: "reviewer", actualModel: "offline/observed", supervision: { error: "fixture real issue" } } } } }];
 const visibleRisk = terminalStack(risk, 120, 24, theme).todo.join("\n");
 assert.match(visibleRisk, /历史完成项0/); assert.match(visibleRisk, /待核实|异常|需核实/); assert.match(visibleRisk, /offline\/observed/);
 assert.equal(JSON.stringify(input), before);
});
