import { SessionInfo, UnloadResult } from './types';
export { SessionInfo, UnloadResult } from './types';
export declare function loadFoundationModelsServer(modelId: string, port: number, apiKey: string, timeout?: number): Promise<SessionInfo>;
export declare function unloadFoundationModelsServer(pid: number): Promise<UnloadResult>;
export declare function isFoundationModelsProcessRunning(pid: number): Promise<boolean>;
export declare function getFoundationModelsRandomPort(): Promise<number>;
export declare function findFoundationModelsSession(): Promise<SessionInfo | null>;
export declare function isFoundationModelsLoaded(): Promise<boolean>;
export declare function getAllFoundationModelsSessions(): Promise<SessionInfo[]>;
export declare function cleanupFoundationModelsProcesses(): Promise<void>;
/**
 * Run `foundation-models-server --check` and return a machine-readable
 * availability token. Possible values:
 *   - `"available"`                  — device is eligible and ready
 *   - `"notEligible"`                — device does not support Apple Intelligence
 *   - `"appleIntelligenceNotEnabled"` — Apple Intelligence disabled in Settings
 *   - `"modelNotReady"`              — model is still downloading
 *   - `"unavailable"`                — other unavailability reason
 *   - `"binaryNotFound"`             — server binary was not bundled (non-macOS build)
 */
export declare function checkFoundationModelsAvailability(): Promise<string>;
