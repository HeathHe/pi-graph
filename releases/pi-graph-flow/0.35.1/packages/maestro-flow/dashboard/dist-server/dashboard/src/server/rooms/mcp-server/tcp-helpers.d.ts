import { type Socket } from 'node:net';
export declare function writeTcpMessage(socket: Socket, payload: unknown): boolean;
export interface TcpMessageReader {
    /** Feed a raw TCP chunk. Returns zero or more decoded messages. */
    feed(chunk: Buffer): unknown[];
}
export declare function createTcpMessageReader(): TcpMessageReader;
export interface TcpRequestOptions {
    port: number;
    host?: string;
    payload: unknown;
    timeoutMs?: number;
}
export declare function sendTcpRequest(opts: TcpRequestOptions): Promise<unknown>;
