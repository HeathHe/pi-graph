import { describe, it, expect } from 'vitest';
import { SdkMessageTranslator } from './sdk-message-translator.js';
describe('SdkMessageTranslator', () => {
    const PID = 'test-process-001';
    function createTranslator() {
        return new SdkMessageTranslator(PID);
    }
    // --- test_sdk_message_translator_assistant_text ---
    describe('assistant text translation', () => {
        it('translates assistant text block to assistant_message', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [{ type: 'text', text: 'Hello world' }],
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('assistant_message');
            expect(entries[0]).toMatchObject({
                processId: PID,
                type: 'assistant_message',
                content: 'Hello world',
                partial: false,
            });
        });
        it('translates thinking block to thinking entry', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [{ type: 'thinking', thinking: 'Let me think...' }],
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('thinking');
            expect(entries[0]).toMatchObject({
                type: 'thinking',
                content: 'Let me think...',
            });
        });
        it('translates multiple content blocks from single assistant message', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'Reasoning...' },
                        { type: 'text', text: 'Answer here' },
                    ],
                },
            });
            expect(entries).toHaveLength(2);
            expect(entries[0].type).toBe('thinking');
            expect(entries[1].type).toBe('assistant_message');
        });
        it('translates assistant error to error entry', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                error: 'Something went wrong',
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('error');
            expect(entries[0]).toMatchObject({
                type: 'error',
                message: 'Assistant error: Something went wrong',
            });
        });
    });
    // --- test_sdk_message_translator_tool_use_routing ---
    describe('tool use routing', () => {
        it('routes Edit tool to file_change with action=modify', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tu-1',
                            name: 'Edit',
                            input: { file_path: '/src/main.ts' },
                        },
                    ],
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('file_change');
            expect(entries[0]).toMatchObject({
                type: 'file_change',
                path: '/src/main.ts',
                action: 'modify',
            });
        });
        it('routes Write tool to file_change with action=create', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tu-2',
                            name: 'Write',
                            input: { file_path: '/src/new-file.ts' },
                        },
                    ],
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('file_change');
            expect(entries[0]).toMatchObject({
                type: 'file_change',
                path: '/src/new-file.ts',
                action: 'create',
            });
        });
        it('routes Bash tool to command_exec', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tu-3',
                            name: 'Bash',
                            input: { command: 'npm test' },
                        },
                    ],
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('command_exec');
            expect(entries[0]).toMatchObject({
                type: 'command_exec',
                command: 'npm test',
            });
        });
        it('routes unknown tool to generic tool_use', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tu-4',
                            name: 'Read',
                            input: { file_path: '/some/path' },
                        },
                    ],
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('tool_use');
            expect(entries[0]).toMatchObject({
                type: 'tool_use',
                name: 'Read',
                status: 'running',
            });
        });
        it('correlates tool_use result with pending tool', () => {
            const translator = createTranslator();
            // First: tool_use block
            translator.translate({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', id: 'tu-5', name: 'Bash', input: { command: 'ls' } },
                    ],
                },
            });
            // Then: tool result
            const entries = translator.translate({
                type: 'user',
                tool_use_result: {
                    tool_use_id: 'tu-5',
                    output: 'file1.ts\nfile2.ts',
                    is_error: false,
                },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe('command_exec');
            expect(entries[0]).toMatchObject({
                type: 'command_exec',
                command: 'ls',
                output: 'file1.ts\nfile2.ts',
                exitCode: 0,
            });
        });
    });
    // --- test_sdk_message_translator_result_success ---
    describe('result success translation', () => {
        it('translates success result to assistant_message + token_usage + status_change', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'result',
                subtype: 'success',
                result: 'Task completed successfully',
                usage: {
                    input_tokens: 1000,
                    output_tokens: 500,
                    cache_read_input_tokens: 200,
                    cache_creation_input_tokens: 100,
                },
            });
            expect(entries).toHaveLength(3);
            expect(entries[0].type).toBe('assistant_message');
            expect(entries[0]).toMatchObject({
                content: 'Task completed successfully',
                partial: false,
            });
            expect(entries[1].type).toBe('token_usage');
            expect(entries[1]).toMatchObject({
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 200,
                cacheWriteTokens: 100,
            });
            expect(entries[2].type).toBe('status_change');
            expect(entries[2]).toMatchObject({
                status: 'stopped',
            });
        });
        it('handles success result without result text', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'result',
                subtype: 'success',
                usage: { input_tokens: 100, output_tokens: 50 },
            });
            // Should have token_usage + status_change (no assistant_message since no result text)
            expect(entries).toHaveLength(2);
            expect(entries[0].type).toBe('token_usage');
            expect(entries[1].type).toBe('status_change');
        });
    });
    // --- test_sdk_message_translator_result_error ---
    describe('result error translation', () => {
        it('translates error result to error + status_change', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'result',
                subtype: 'error',
                error: 'Rate limit exceeded',
            });
            expect(entries).toHaveLength(2);
            expect(entries[0].type).toBe('error');
            expect(entries[0]).toMatchObject({
                message: 'Rate limit exceeded',
                code: 'error',
            });
            expect(entries[1].type).toBe('status_change');
            expect(entries[1]).toMatchObject({
                status: 'error',
                reason: 'error',
            });
        });
    });
    // --- Additional coverage ---
    describe('other message types', () => {
        it('translates system init to status_change running', () => {
            const translator = createTranslator();
            const entries = translator.translate({ type: 'system', subtype: 'init' });
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ type: 'status_change', status: 'running' });
        });
        it('translates rate_limit_event to error', () => {
            const translator = createTranslator();
            const entries = translator.translate({ type: 'rate_limit_event' });
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
                type: 'error',
                message: 'Rate limit reached',
                code: 'RATE_LIMIT',
            });
        });
        it('translates tool_progress to tool_use running', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'tool_progress',
                tool_name: 'Bash',
            });
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
                type: 'tool_use',
                name: 'Bash',
                status: 'running',
            });
        });
        it('skips internal SDK message types', () => {
            const translator = createTranslator();
            const skippedTypes = [
                'compact_boundary',
                'user_message_replay',
                'auth_status',
                'hook_response',
                'prompt_suggestion',
                'status',
            ];
            for (const type of skippedTypes) {
                const entries = translator.translate({ type });
                expect(entries).toHaveLength(0);
            }
        });
        it('skips unknown message types', () => {
            const translator = createTranslator();
            const entries = translator.translate({ type: 'totally_unknown_type' });
            expect(entries).toHaveLength(0);
        });
        it('translates user message (non-tool-result, non-synthetic)', () => {
            const translator = createTranslator();
            const entries = translator.translate({
                type: 'user',
                message: { content: [{ type: 'text', text: 'Hello' }] },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
                type: 'user_message',
                content: 'Hello',
            });
        });
    });
});
//# sourceMappingURL=sdk-message-translator.test.js.map