import { describe, expect, it } from 'vitest'

import { loadDiagProps, parseLoadDiag, stripLoadDiag } from '@/lib/load-diag'

const details = (...lines: string[]) => lines.join('\n')

describe('parseLoadDiag', () => {
  it('reads the JSON after the last atomic-core-diag line', () => {
    const text = details(
      'ggml_cuda_init: failed to initialize CUDA',
      'atomic-core-diag {"stage":"spawn","backend":"cuda-12.4"}',
      'retrying on vulkan',
      'atomic-core-diag {"exit_code":-1073741795,"stage":"health","backend":"vulkan","fallback_from":"cuda-12.4","fallback_to":"vulkan","fallback_ok":false}'
    )
    expect(parseLoadDiag(text)).toEqual({
      exit_code: -1073741795,
      stage: 'health',
      backend: 'vulkan',
      fallback_from: 'cuda-12.4',
      fallback_to: 'vulkan',
      fallback_ok: false,
    })
  })

  it('tolerates CRLF line ends and surrounding whitespace', () => {
    expect(
      parseLoadDiag('crash\r\n  atomic-core-diag {"empty_stderr":true}  \r\n')
    ).toEqual({ empty_stderr: true })
  })

  it('returns null for no line, garbage, or JSON that is not an object', () => {
    expect(parseLoadDiag(undefined)).toBeNull()
    expect(parseLoadDiag('')).toBeNull()
    expect(parseLoadDiag('plain stderr, no diag')).toBeNull()
    expect(parseLoadDiag('atomic-core-diag {not json')).toBeNull()
    expect(parseLoadDiag('atomic-core-diag [1,2]')).toBeNull()
    expect(parseLoadDiag('atomic-core-diag null')).toBeNull()
    // The prefix has to start the line.
    expect(parseLoadDiag('note: atomic-core-diag {"stage":"x"}')).toBeNull()
  })
})

describe('stripLoadDiag', () => {
  it('drops every diag line and keeps the rest', () => {
    expect(
      stripLoadDiag(
        details(
          'line one',
          'atomic-core-diag {"stage":"spawn"}',
          'line two',
          'atomic-core-diag {"stage":"health"}'
        )
      )
    ).toBe('line one\nline two')
  })

  it('returns undefined when the diag was all there was', () => {
    expect(
      stripLoadDiag('atomic-core-diag {"empty_stderr":true}')
    ).toBeUndefined()
    expect(stripLoadDiag(undefined)).toBeUndefined()
  })

  it('leaves text without a diag line untouched', () => {
    expect(stripLoadDiag('  as is \n')).toBe('  as is \n')
  })
})

describe('loadDiagProps', () => {
  it('maps the diag onto model_load properties', () => {
    expect(
      loadDiagProps({
        exit_code: 139,
        signal: 11,
        stage: 'load_model',
        backend: 'cuda-12.4',
        build: 'b6000',
        fallback_from: 'cuda-13.3',
        fallback_to: 'cuda-12.4',
        fallback_ok: true,
        empty_stderr: false,
      })
    ).toEqual({
      exit_code: 139,
      exit_signal: '11',
      startup_stage: 'load_model',
      ran_backend: 'cuda-12.4',
      engine_build: 'b6000',
      fallback_from: 'cuda-13.3',
      fallback_to: 'cuda-12.4',
      fallback_ok: true,
      empty_stderr: false,
    })
  })

  it('is all null without a diag, so every failure has the same properties', () => {
    expect(Object.values(loadDiagProps(null))).toEqual(Array(9).fill(null))
  })

  it('drops wrongly typed values and keeps strings short and scrubbed', () => {
    const props = loadDiagProps({
      exit_code: '3221225477',
      fallback_ok: 'yes',
      empty_stderr: 1,
      stage: { nested: true },
      backend: 'C:\\Users\\alice\\backend\\' + 'x'.repeat(100),
    })
    expect(props.exit_code).toBe(3221225477)
    expect(props.fallback_ok).toBeNull()
    expect(props.empty_stderr).toBeNull()
    expect(props.startup_stage).toBeNull()
    expect(props.ran_backend).not.toContain('alice')
    expect(props.ran_backend!.length).toBeLessThanOrEqual(64)
  })
})
