#!/usr/bin/env node
const { runContextMonitor } = await import('../dist/src/hooks/context-monitor.js');
runContextMonitor();
