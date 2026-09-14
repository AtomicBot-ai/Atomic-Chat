import { DEFAULT_CTX_LEN } from '@janhq/core'
import { describe, expect, it } from 'vitest'

import {
  customModelSettingKeys,
  withDefaultModelSettings,
} from '@/lib/model-settings-defaults'

const setting = (key: string, value: unknown) =>
  ({
    key,
    title: key,
    description: '',
    controller_type: 'input',
    controller_props: { value, type: 'number' },
  }) as unknown as ProviderSetting

describe('customModelSettingKeys', () => {
  it('lists the load options that are off their default', () => {
    expect(
      customModelSettingKeys({
        ctx_len: setting('ctx_len', 8192),
        ngl: setting('ngl', 100),
        batch_size: setting('batch_size', 512),
      })
    ).toEqual(['ctx_len', 'batch_size'])
  })

  it('treats a typed number and an unset field as their stored twins', () => {
    expect(
      customModelSettingKeys({
        ctx_len: setting('ctx_len', String(DEFAULT_CTX_LEN)),
        n_cpu_moe: setting('n_cpu_moe', undefined),
      })
    ).toEqual([])
  })

  it('leaves sampling and settings without a default out', () => {
    expect(
      customModelSettingKeys({
        temperature: setting('temperature', 1.4),
        offload_mmproj: setting('offload_mmproj', false),
      })
    ).toEqual([])
  })
})

describe('withDefaultModelSettings', () => {
  it('puts only the given keys back on their default', () => {
    const settings = {
      ctx_len: setting('ctx_len', 8192),
      ngl: setting('ngl', 20),
      temperature: setting('temperature', 1.4),
    }

    const reset = withDefaultModelSettings(settings, ['ngl', 'temperature'])

    expect(reset.ngl.controller_props.value).toBe(100)
    expect(reset.ngl.controller_props.type).toBe('number')
    expect(reset.ctx_len.controller_props.value).toBe(8192)
    expect(reset.temperature.controller_props.value).toBe(1.4)
  })

  it('does not add settings the model never had', () => {
    expect(
      Object.keys(
        withDefaultModelSettings({ ctx_len: setting('ctx_len', 8192) }, [
          'ctx_len',
          'batch_size',
        ])
      )
    ).toEqual(['ctx_len'])
  })
})
