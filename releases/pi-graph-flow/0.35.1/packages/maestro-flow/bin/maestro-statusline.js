#!/usr/bin/env node
import '../dist/src/hooks/statusline.js';
const { runStatusline } = await import('../dist/src/hooks/statusline.js');
runStatusline();
