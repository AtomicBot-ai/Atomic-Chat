import { describe, expect, it } from 'vitest'
import { buildMlxConfig, selectMlxDraftSettings } from './buildMlxConfig'

describe('selectMlxDraftSettings', () => {
  it.each([
    [
      'dflash',
      { dflash_enabled: true, draft_model_path: 'draft/dflash', block_size: 16 },
      16,
    ],
    [
      'mtp',
      { mtp_enabled: true, draft_model_path: 'draft/mtp', mtp_block_size: 4 },
      4,
    ],
    [
      'eagle3',
      {
        eagle3_enabled: true,
        draft_model_path: 'draft/eagle3',
        eagle3_block_size: 0,
      },
      0,
    ],
  ] as const)('selects %s settings', (draftKind, config, blockSize) => {
    expect(selectMlxDraftSettings(config)).toEqual({
      draftKind,
      draftPath: `draft/${draftKind}`,
      blockSize,
    })
  })

  it('keeps the documented mtp then eagle3 then dflash precedence', () => {
    expect(
      selectMlxDraftSettings({
        dflash_enabled: true,
        mtp_enabled: true,
        eagle3_enabled: true,
        draft_model_path: 'draft/shared',
      })
    ).toEqual({
      draftKind: 'mtp',
      draftPath: 'draft/shared',
      blockSize: 4,
    })
  })
})

describe('buildMlxConfig', () => {
  it('removes all draft arguments when the resolved path is empty', () => {
    expect(
      buildMlxConfig(
        { ctx_size: 32_768 },
        { draftKind: 'mtp', draftPath: '  ', blockSize: 4 }
      )
    ).toEqual({
      ctx_size: 32_768,
      draft_model_path: '',
      block_size: 0,
      draft_kind: 'dflash',
      kv_bits: 0,
      kv_quant_scheme: '',
    })
  })

  it.each([
    ['uniform', 8, 'uniform', 8],
    ['turboquant', 3.5, 'turboquant', 3.5],
    ['off', 3.5, '', 0],
    ['unknown', 3.5, '', 0],
    ['uniform', 0, '', 0],
    ['turboquant', -1, '', 0],
  ])(
    'normalizes KV scheme %s with bits %s',
    (scheme, bits, expectedScheme, expectedBits) => {
      const result = buildMlxConfig(
        { kv_quant_scheme: scheme, kv_bits: bits },
        { draftKind: 'dflash', draftPath: '', blockSize: 0 }
      )

      expect(result.kv_quant_scheme).toBe(expectedScheme)
      expect(result.kv_bits).toBe(expectedBits)
    }
  )
})
