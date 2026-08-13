import { type Server } from "node:http";
import type { TeleportAuthority } from "./authority.js";
export interface TeleportServerOptions {
    apiToken?: string;
    adminToken?: string;
    maxBodyBytes?: number;
    publicBaseUrl?: string;
}
export interface RunningTeleportServer {
    server: Server;
    listen(host?: string, port?: number): Promise<{
        host: string;
        port: number;
        url: string;
    }>;
    close(): Promise<void>;
}
export declare function createTeleportServer(authority: TeleportAuthority, options?: TeleportServerOptions): RunningTeleportServer;
