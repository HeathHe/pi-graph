#!/usr/bin/env node
const { runDelegateMonitor } = await import('../dist/src/hooks/delegate-monitor.js');
runDelegateMonitor();
