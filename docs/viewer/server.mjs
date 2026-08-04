#!/usr/bin/env node
/**
 * π-graph Run Viewer 本地服务器（零依赖，仅 node:http / node:fs）
 *
 * 用法：
 *   node docs/viewer/server.mjs            # 默认端口 7474
 *   PORT=8000 node docs/viewer/server.mjs  # 覆盖端口
 *   GRAPH_RUNS_DIR=/path/to/runs node docs/viewer/server.mjs  # 覆盖 runs 根目录
 *
 * 端点：
 *   GET /                              -> index.html
 *   GET /api/runs                      -> { runs: [{ id, status, updatedAt, goal }] }（按 updatedAt 倒序）
 *   GET /api/runs/:id/snapshot         -> 该 run 的 snapshot.json 原文
 *   GET /api/runs/:id/events           -> 该 run 的 events.jsonl 原文（text/plain）
 *   GET /api/runs/:id/graph            -> 该 run 的 graph.json 原文（不存在则 404，viewer 降级）
 *
 * 安全：仅绑定 127.0.0.1；run id 仅允许 [A-Za-z0-9._-] 且拒绝 ".."，防目录穿越。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 7474);
const RUNS_DIR = path.resolve(process.env.GRAPH_RUNS_DIR || path.join(os.homedir(), '.pi/agent/graph-runs'));
const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const ID_RE = /^[A-Za-z0-9._-]+$/;

const TYPE_HTML = 'text/html; charset=utf-8';
const TYPE_JSON = 'application/json; charset=utf-8';
const TYPE_TEXT = 'text/plain; charset=utf-8';

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || TYPE_TEXT, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), TYPE_JSON);
}

/** id 白名单校验 + 解析后路径必须仍位于 RUNS_DIR 内 */
function safeRunDir(id) {
  if (!ID_RE.test(id) || id.includes('..')) return null;
  const dir = path.resolve(RUNS_DIR, id);
  if (dir !== path.join(RUNS_DIR, id)) return null;
  return dir;
}

/** 扫描 runs 根目录，读取各 run 的 snapshot.json 摘要；读不到时回退目录 mtime */
function listRuns() {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name) || e.name.startsWith('.')) continue;
    const dir = path.join(RUNS_DIR, e.name);
    let status = 'unknown';
    let goal = '';
    let updatedAt = null;
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
      status = snap.status || status;
      goal = snap.goal || '';
      updatedAt = snap.updatedAt || snap.createdAt || null;
    } catch {
      try { updatedAt = fs.statSync(dir).mtime.toISOString(); } catch { /* ignore */ }
    }
    runs.push({ id: e.name, status, updatedAt, goal });
  }
  runs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return runs;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }

  if (pathname === '/' || pathname === '/index.html') {
    try {
      return send(res, 200, fs.readFileSync(INDEX_HTML), TYPE_HTML);
    } catch {
      return sendJson(res, 500, { error: 'index.html not found next to server.mjs' });
    }
  }

  if (pathname === '/api/runs') {
    return sendJson(res, 200, { runs: listRuns() });
  }

  const m = pathname.match(/^\/api\/runs\/([^/]+)\/(snapshot|events|graph)$/);
  if (m) {
    const dir = safeRunDir(m[1]);
    if (!dir) return sendJson(res, 400, { error: 'invalid run id' });
    const file = m[2] === 'events' ? 'events.jsonl' : m[2] + '.json';
    let data;
    try {
      data = fs.readFileSync(path.join(dir, file));
    } catch {
      return sendJson(res, 404, { error: file + ' not found for run ' + m[1] });
    }
    return send(res, 200, data, m[2] === 'events' ? TYPE_TEXT : TYPE_JSON);
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`π-graph viewer: http://127.0.0.1:${PORT}/  (runs: ${RUNS_DIR})`);
});
