/**
 * Default Analytic Service - Web implementation
 */

import { AppConfiguration } from '@janhq/core'
import type { AnalyticService } from './types'

export class DefaultAnalyticService implements AnalyticService {
  async updateDistinctId(id: string): Promise<void> {
    // `getAppConfigurations` resolves to `null` on a platform without the
    // Tauri bridge (see `lib/service.ts`), so the result needs a guard of its
    // own — the optional chaining above only covers a missing `window.core`.
    const appConfiguration: AppConfiguration | null =
      (await window.core?.api?.getAppConfigurations()) ?? null
    if (!appConfiguration) return
    appConfiguration.distinct_id = id
    await window.core?.api?.updateAppConfiguration({
      configuration: appConfiguration,
    })
  }

  async getAppDistinctId(): Promise<string | undefined> {
    const appConfiguration: AppConfiguration | null =
      (await window.core?.api?.getAppConfigurations()) ?? null
    return appConfiguration?.distinct_id
  }
}
