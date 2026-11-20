import { Hono } from 'hono';
import type { RoomSessionManager } from '../rooms/room-session-manager.js';
export declare function createRoomRoutes(roomSessionManager: RoomSessionManager): Hono;
