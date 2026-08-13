export const localStorageKey = {
  LeftPanel: 'left-panel',
  threads: 'threads',
  messages: 'messages',
  theme: 'theme',
  modelProvider: 'model-provider',
  modelSources: 'model-sources',
  settingInterface: 'setting-appearance',
  settingGeneral: 'setting-general',
  settingCodeBlock: 'setting-code-block',
  settingLocalApiServer: 'setting-local-api-server',
  settingProxyConfig: 'setting-proxy-config',
  settingHardware: 'setting-hardware',
  settingVulkan: 'setting-vulkan',
  productAnalyticPrompt: 'productAnalyticPrompt',
  productAnalytic: 'productAnalytic',
  toolApproval: 'tool-approval',
  toolAvailability: 'tool-availability',
  mcpGlobalPermissions: 'mcp-global-permissions',
  lastUsedModel: 'last-used-model',
  lastUsedAssistant: 'last-used-assistant',
  defaultAssistantId: 'default-assistant-id',
  // Former app-wide sampling bag (temperature/top_p/top_k/min_p/penalties).
  // Sampling is per-assistant again; this entry is only read once by the
  // migration below and then kept for rollback.
  samplingSettings: 'sampling-settings',
  // Marks that the app-wide sampling bag has been moved onto the assistants
  // that had none of their own. Set even when there was nothing to migrate.
  samplingMigratedPerAssistant: 'sampling-migrated-per-assistant',
  favoriteModels: 'favorite-models',
  setupCompleted: 'setup-completed',
  // Marks that the user has completed (either Skip or Download) the dedicated
  // Windows-only llama.cpp backend onboarding step. Once set, the extension
  // stops emitting `onBetterBackendDetected` events automatically — the
  // recommendation can still be surfaced manually via the "Find optimal
  // backend" button in provider settings.
  llamacppOnboardingDone: 'llama_cpp_onboarding_done',
  threadManagement: 'thread-management',
  modelSupportCache: 'jan_model_support_cache',
  recentSearches: 'recent-searches',
  // Set when onboarding is left without a model (Skip or the auto-exit
  // timeout) and cleared once the bottom-right reminder has been acted on or
  // dismissed. Survives a restart so the offer is not lost with the session.
  onboardingModelReminder: 'atomic-onboarding-model-reminder',
  agentMode: 'agent-mode',
  agentModeAttentionSeen: 'agent-mode-attention-seen-v1',
  factoryResetPending: 'factory-reset-pending',
  lastSeenVersion: 'last-seen-version',
  threadNotifications: 'thread-notifications',
  // macOS only: marks the one-time migration of the autostart launcher from the
  // legacy LaunchAgent plist to a real AppleScript Login Item. Preserves prior
  // state — users who had autostart ON keep it; those who had it off stay off.
  autostartAppleScriptMigrated: 'autostart-applescript-migrated',
  // Per-integration manual binary-path overrides for the Launch page. Lets a
  // user fix a wrong "Not installed" status for agents installed in a
  // non-standard location that PATH/WSL detection misses.
  launchCustomPaths: 'launch-custom-paths',
  // Windows/Linux only: marks that the once-ever "find optimal backend" prompt
  // for the turboquant (`llamacpp`) provider has been shown after the first
  // model launch on that backend. Set on Skip OR Find so the popup never
  // reappears; the optimal-backend recommendation stays reachable via the
  // manual button in provider settings.
  turboquantOptimalPromptShown: 'turboquant-optimal-prompt-shown',
  // Backend pairs ("<configured>→<effective-or-ideal>") the user chose never to
  // be reminded about again. Suppression is per pair, not global, so a later
  // hardware or backend change still surfaces a fresh mismatch.
  backendMismatchSuppressed: 'backend-mismatch-suppressed',
  // Last startup attempt to silently upgrade the upstream llama.cpp backend to
  // the tier detection picked for this host. Written before the download starts
  // so a crash or a failure mid-download cannot retry on every launch.
  startupBackendUpgradeAttempt: 'startup-backend-upgrade-attempt',
}

export const CACHE_EXPIRY_MS = 1000 * 60 * 60 * 24
