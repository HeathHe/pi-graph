#!/usr/bin/env node
const { runTeamMonitorFromStdin } = await import('../dist/src/hooks/team-monitor.js');
runTeamMonitorFromStdin();
