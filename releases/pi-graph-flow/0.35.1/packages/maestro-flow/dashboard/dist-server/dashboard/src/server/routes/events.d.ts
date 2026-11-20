import { Hono } from 'hono';
import type { StateManager } from '../state/state-manager.js';
import type { SSEHub } from '../sse/sse-hub.js';
/**
 * SSE events route.
 *
 * GET /events - Server-Sent Events stream.
 *   1. Sends initial board snapshot as "board:full" event.
 *   2. Forwards all EventBus events in real time.
 *   3. Heartbeat comments are handled by SSEHub.
 *   4. Returns 503 when max connections reached.
 */
export declare function createEventsRoute(stateManager: StateManager, _eventBus: unknown, sseHub: SSEHub): Hono;
