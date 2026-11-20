import { Hono } from 'hono';
import type { StateManager } from '../state/state-manager.js';
export declare function createHealthRoute(workflowRoot: string, stateManager?: StateManager): Hono;
