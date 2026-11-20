import { Hono } from 'hono';
import type { DashboardEventBus } from '../state/event-bus.js';
export declare function createCollabRoutes(workflowRoot: string | (() => string), _eventBus: DashboardEventBus): Hono;
