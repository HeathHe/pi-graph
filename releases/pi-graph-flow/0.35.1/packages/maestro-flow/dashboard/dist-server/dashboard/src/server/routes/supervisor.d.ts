import { Hono } from 'hono';
import type { SelfLearningService } from '../supervisor/self-learning-service.js';
import type { TaskSchedulerService } from '../supervisor/task-scheduler-service.js';
import type { ExtensionManager } from '../supervisor/extension-manager.js';
import type { PromptRegistry } from '../prompt/prompt-registry.js';
/**
 * Supervisor routes following the Hono factory pattern.
 *
 * GET    /api/supervisor/prompts              list registered builders
 * PUT    /api/supervisor/prompts/config       update strategy->mode bindings
 * POST   /api/supervisor/prompts/preview      render template with sample data
 * GET    /api/supervisor/schedules            list all scheduled tasks
 * POST   /api/supervisor/schedules            create new scheduled task
 * PUT    /api/supervisor/schedules/:id        update scheduled task
 * DELETE /api/supervisor/schedules/:id        delete scheduled task
 * POST   /api/supervisor/schedules/:id/run    manual trigger
 * GET    /api/supervisor/learning/stats       LearningStats
 * GET    /api/supervisor/learning/patterns    CommandPatterns
 * GET    /api/supervisor/learning/kb          KnowledgeBase entries
 * GET    /api/supervisor/extensions           list registered extensions
 */
export declare function createSupervisorRoutes(learningService: SelfLearningService, schedulerService: TaskSchedulerService, extensionManager: ExtensionManager, promptRegistry: PromptRegistry): Hono;
