/**
 * Tauri Opener Service - Desktop implementation
 */

import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { DefaultOpenerService } from './default'

export class TauriOpenerService extends DefaultOpenerService {
  async open(target: string): Promise<void> {
    try {
      await openUrl(target)
    } catch (error) {
      console.error('Error opening target in Tauri:', error)
      throw error
    }
  }

  async revealItemInDir(path: string): Promise<void> {
    try {
      await revealItemInDir(path)
    } catch (error) {
      console.error('Error revealing item in directory in Tauri:', error)
      throw error
    }
  }
}
