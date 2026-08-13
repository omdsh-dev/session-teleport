export declare const TELEPORT_PACKAGE = "@mattheliu/session-teleport";
export type PluginLifecycleAction = "install" | "upgrade" | "uninstall" | "doctor";
export type CheckStatus = "pass" | "warn" | "fail";
export interface PluginLifecycleOptions {
    action: PluginLifecycleAction;
    profile: string;
    revision?: string;
    apply?: boolean;
    profileStopped?: boolean;
    cutoverSafe?: boolean;
    offline?: boolean;
    environment?: Readonly<Record<string, string | undefined>>;
    dshCommand?: string;
    dshArgsPrefix?: readonly string[];
}
export interface LifecycleCheck {
    name: string;
    status: CheckStatus;
    detail: string;
}
export interface PluginLifecycleResult {
    action: PluginLifecycleAction;
    profile: string;
    applied: boolean;
    restartRequired: boolean;
    previousSpec?: string;
    currentSpec?: string;
    checks: LifecycleCheck[];
    notes: string[];
}
/**
 * Plan or apply one controlled DSH profile plugin lifecycle operation.
 * Install/uninstall are authority cutovers; upgrade preserves the authority
 * but still requires the profile to be stopped. No operation deletes writer
 * credentials, import receipts, or PostgreSQL data.
 */
export declare function runPluginLifecycle(options: PluginLifecycleOptions): Promise<PluginLifecycleResult>;
export declare function lifecyclePlan(action: Exclude<PluginLifecycleAction, "doctor">, profile: string, previousSpec?: string, desiredSpec?: string): string[];
