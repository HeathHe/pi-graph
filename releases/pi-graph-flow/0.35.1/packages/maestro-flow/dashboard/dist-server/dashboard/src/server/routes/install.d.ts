/**
 * Install Routes — Interactive install wizard API endpoints.
 *
 * Dashboard web UI counterpart of CLI `maestro install` (src/commands/install.ts).
 * Uses the same manifest format and storage path (~/.maestro/manifests/).
 */
import { Hono } from 'hono';
export declare function createInstallRoutes(): Hono;
