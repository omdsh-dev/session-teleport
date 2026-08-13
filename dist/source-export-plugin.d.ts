import type { SessionSnapshotSource } from "./importer.js";
export interface SourceExportPluginConfig {
    sessionId: string;
    outputPath: string;
    statusPath: string;
    nonce: string;
}
interface SourceExportContext {
    sessionPersistence: SessionSnapshotSource & {
        name?: string;
    };
}
/**
 * One-shot, read-only overlay used by `dsh-teleport-import capture`.
 *
 * This function intentionally has no Cordis or DSH runtime import. Attaching
 * `inject` directly to the default-exported function lets an old profile load
 * the temporary overlay without installing this package's optional peers.
 */
export declare function apply(ctx: SourceExportContext, config: SourceExportPluginConfig): Promise<void>;
export declare namespace apply {
    var inject: string[];
}
export default apply;
