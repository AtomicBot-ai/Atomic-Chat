import { describe, expect, it } from 'vitest'
import {
  asNumber,
  buildMlxConfig,
  MLX_DEFAULT_CTX_CAP,
  MLX_DEFAULT_CTX_FALLBACK,
  resolveMlxCtxSize,
  selectMlxDraftSettings,
} from './buildMlxConfig'

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

describe('numeric settings that arrive as strings', () => {
  it('reads kv_bits as settings.json ships it, so --kv-bits actually goes out', () => {
    // The default was the string "3.5" and the check was
    // `typeof === 'number'`: KV-cache quantisation could never switch on.
    const result = buildMlxConfig(
      { kv_quant_scheme: 'turboquant', kv_bits: '3.5' },
      { draftKind: 'dflash', draftPath: '', blockSize: 0 }
    )
    expect(result.kv_bits).toBe(3.5)
    expect(result.kv_quant_scheme).toBe('turboquant')
  })

  it('reads the drafter block sizes the same way', () => {
    expect(
      selectMlxDraftSettings({
        dflash_enabled: true,
        draft_model_path: 'draft/dflash',
        block_size: '24',
      }).blockSize
    ).toBe(24)
  })

  it('treats an unparseable value as unset', () => {
    expect(asNumber('')).toBeUndefined()
    expect(asNumber('abc')).toBeUndefined()
    expect(asNumber(NaN)).toBeUndefined()
    expect(asNumber('8')).toBe(8)
  })
})

describe('resolveMlxCtxSize', () => {
  it('defaults to the training maximum, capped', () => {
    expect(resolveMlxCtxSize(undefined, 8192)).toBe(8192)
    expect(resolveMlxCtxSize(undefined, 262_144)).toBe(MLX_DEFAULT_CTX_CAP)
  })

  it('falls back small when the training maximum is unknown', () => {
    expect(resolveMlxCtxSize(undefined, undefined)).toBe(MLX_DEFAULT_CTX_FALLBACK)
  })

  it('keeps an explicit value, clamped to what the model was trained for', () => {
    // MLX never clamped, unlike llama.cpp, so it could ask for a window the
    // model was not trained to hold.
    expect(resolveMlxCtxSize(32_768, 131_072)).toBe(32_768)
    expect(resolveMlxCtxSize('32768', 8192)).toBe(8192)
    expect(resolveMlxCtxSize(32_768, undefined)).toBe(32_768)
  })

  it('is what buildMlxConfig loads with', () => {
    expect(
      buildMlxConfig(
        {},
        { draftKind: 'dflash', draftPath: '', blockSize: 0 },
        { maxCtxTrain: 40_960 }
      ).ctx_size
    ).toBe(MLX_DEFAULT_CTX_CAP)
  })
})
