import type { MlxConfig } from '../../../src-tauri/plugins/tauri-plugin-mlx/guest-js/index'

export type MlxDraftKind = 'dflash' | 'mtp' | 'eagle3'

export interface MlxExtensionConfigInput {
  ctx_size?: number
  draft_model_path?: string
  block_size?: number
  dflash_enabled?: boolean
  mtp_enabled?: boolean
  mtp_block_size?: number
  eagle3_enabled?: boolean
  eagle3_block_size?: number
  kv_bits?: number
  kv_quant_scheme?: string
}

export interface MlxDraftSelection {
  draftKind: MlxDraftKind
  draftPath: string
  blockSize: number
}

export function selectMlxDraftSettings(
  config: MlxExtensionConfigInput
): MlxDraftSelection {
  if (config.mtp_enabled) {
    return {
      draftKind: 'mtp',
      draftPath: config.draft_model_path ?? '',
      blockSize: config.mtp_block_size ?? 4,
    }
  }
  if (config.eagle3_enabled) {
    return {
      draftKind: 'eagle3',
      draftPath: config.draft_model_path ?? '',
      blockSize: config.eagle3_block_size ?? 0,
    }
  }
  if (config.dflash_enabled) {
    return {
      draftKind: 'dflash',
      draftPath: config.draft_model_path ?? '',
      blockSize: config.block_size ?? 16,
    }
  }
  return {
    draftKind: 'dflash',
    draftPath: '',
    blockSize: 0,
  }
}

export function buildMlxConfig(
  config: MlxExtensionConfigInput,
  draft: MlxDraftSelection
): MlxConfig {
  const draftPath = draft.draftPath.trim()
  const kvScheme =
    config.kv_quant_scheme === 'uniform' ||
    config.kv_quant_scheme === 'turboquant'
      ? config.kv_quant_scheme
      : ''
  const kvBits =
    kvScheme && typeof config.kv_bits === 'number' && config.kv_bits > 0
      ? config.kv_bits
      : 0

  return {
    ctx_size: config.ctx_size ?? 4096,
    draft_model_path: draftPath,
    block_size: draftPath ? draft.blockSize : 0,
    draft_kind: draftPath ? draft.draftKind : 'dflash',
    kv_bits: kvBits,
    kv_quant_scheme: kvBits > 0 ? kvScheme : '',
  }
}
