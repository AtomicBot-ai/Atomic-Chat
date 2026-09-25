'use strict';

var core = require('@tauri-apps/api/core');

async function loadFoundationModelsServer(modelId, port, apiKey, timeout = 60) {
    return await core.invoke('plugin:foundation-models|load_foundation_models_server', {
        modelId,
        port,
        apiKey,
        timeout,
    });
}
async function unloadFoundationModelsServer(pid) {
    return await core.invoke('plugin:foundation-models|unload_foundation_models_server', { pid });
}
async function isFoundationModelsProcessRunning(pid) {
    return await core.invoke('plugin:foundation-models|is_foundation_models_process_running', { pid });
}
async function getFoundationModelsRandomPort() {
    return await core.invoke('plugin:foundation-models|get_foundation_models_random_port');
}
async function findFoundationModelsSession() {
    return await core.invoke('plugin:foundation-models|find_foundation_models_session');
}
async function isFoundationModelsLoaded() {
    return await core.invoke('plugin:foundation-models|get_foundation_models_loaded');
}
async function getAllFoundationModelsSessions() {
    return await core.invoke('plugin:foundation-models|get_foundation_models_all_sessions');
}
async function cleanupFoundationModelsProcesses() {
    return await core.invoke('plugin:foundation-models|cleanup_foundation_models_processes');
}
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
async function checkFoundationModelsAvailability() {
    return await core.invoke('plugin:foundation-models|check_foundation_models_availability');
}

exports.checkFoundationModelsAvailability = checkFoundationModelsAvailability;
exports.cleanupFoundationModelsProcesses = cleanupFoundationModelsProcesses;
exports.findFoundationModelsSession = findFoundationModelsSession;
exports.getAllFoundationModelsSessions = getAllFoundationModelsSessions;
exports.getFoundationModelsRandomPort = getFoundationModelsRandomPort;
exports.isFoundationModelsLoaded = isFoundationModelsLoaded;
exports.isFoundationModelsProcessRunning = isFoundationModelsProcessRunning;
exports.loadFoundationModelsServer = loadFoundationModelsServer;
exports.unloadFoundationModelsServer = unloadFoundationModelsServer;
