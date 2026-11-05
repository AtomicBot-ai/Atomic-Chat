import { route } from '@/constants/routes'

/**
 * Where a local engine's settings are: its row on Models Hub → Inference
 * engines, unfolded. That row holds the engine's settings, its setup and
 * troubleshooting panels and their logs. `engineUpdate` also has a managed
 * engine's setup ask to confirm the update (a reinstall) at once.
 *
 * The engine's own page (`route.settings.providers`) remains for its models
 * and helper models, which the row does not show.
 */
export function engineSettingsLink(
  engine: string,
  options: { engineUpdate?: boolean } = {}
) {
  return {
    to: route.settings.model_providers,
    search: {
      openEngine: engine,
      ...(options.engineUpdate ? { engineUpdate: true } : {}),
    },
  }
}
