import { beforeEach, describe, it, expect, vi } from 'vitest'

// Build-time globals read at module scope by localScan (path separator, MLX
// gating) must exist before the module loads.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.IS_TAURI = false
  g.IS_MACOS = true
  g.IS_WINDOWS = false
  g.IS_LINUX = false
})

// An in-memory disk behind the Tauri commands the scanner calls. A path is a
// directory when some file lives under it; `arch` is the GGUF header's
// `general.architecture`, absent when the header can't be read.
const disk = vi.hoisted(() => {
  const files = new Map<string, { size: number; arch?: string }>()
  const isDir = (path: string) =>
    [...files.keys()].some((file) => file.startsWith(`${path}/`))
  const children = (path: string) => {
    const prefix = `${path}/`
    const names = [...files.keys()]
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length).split('/')[0])
    return [...new Set(names)].map((name) => prefix + name)
  }
  const invoke = async (
    command: string,
    payload?: { args?: unknown; path?: string }
  ) => {
    const arg = String(
      Array.isArray(payload?.args) ? payload.args[0] : payload?.args
    )
    switch (command) {
      case 'get_os_home_dir':
        return '/home/me'
      case 'get_env_vars':
        return {}
      case 'exists_sync':
        return files.has(arg) || isDir(arg)
      case 'readdir_sync':
        return children(arg)
      case 'file_stat': {
        const file = files.get(arg)
        if (file) return { isDirectory: false, size: file.size }
        if (isDir(arg)) return { isDirectory: true, size: 0 }
        throw new Error(`ENOENT: ${arg}`)
      }
      case 'plugin:llamacpp|read_gguf_metadata': {
        const arch = files.get(payload?.path ?? '')?.arch
        return { metadata: arch ? { 'general.architecture': arch } : {} }
      }
      default:
        // read_file_sync (HF refs, LM Studio settings), create_symlink.
        throw new Error(`ENOENT: ${command} ${arg}`)
    }
  }
  return { files, invoke }
})

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ core: () => ({ invoke: disk.invoke }) }),
}))

import {
  gpt4allRoots,
  hfCacheRoots,
  isTextGenerationGguf,
  isTextGenerationHfConfig,
  janRoots,
  llamaCppCacheRoots,
  mstyRoots,
  ollamaRoot,
  scanLocalModels,
  unslothRoot,
} from '../localScan'

describe('isTextGenerationGguf', () => {
  it('keeps a plain decoder', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'qwen3',
        'qwen3.block_count': '28',
      })
    ).toBe(true)
  })

  it('rejects an encoder-only embedding backbone (bge / bert)', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'bert',
        'bert.pooling_type': '2',
      })
    ).toBe(false)
  })

  it('rejects an embedding conversion of a generative architecture', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'qwen3',
        'qwen3.pooling_type': '1',
      })
    ).toBe(false)
  })

  it('keeps a decoder that declares pooling type NONE', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'llama',
        'llama.pooling_type': '0',
      })
    ).toBe(true)
  })

  it('rejects a reranker classifier head', () => {
    expect(
      isTextGenerationGguf({
        'general.architecture': 'gemma3',
        'gemma3.classifier.output_labels': '[yes, no]',
      })
    ).toBe(false)
  })

  it('keeps a model with unknown or missing architecture', () => {
    expect(isTextGenerationGguf({})).toBe(true)
    expect(isTextGenerationGguf({ 'general.architecture': 'brand-new' })).toBe(
      true
    )
  })
})

describe('isTextGenerationHfConfig', () => {
  it('keeps a causal LM folder', () => {
    expect(
      isTextGenerationHfConfig(
        JSON.stringify({
          architectures: ['Qwen3ForCausalLM'],
          model_type: 'qwen3',
        })
      )
    ).toBe(true)
  })

  it('rejects an encoder-only embedding folder', () => {
    expect(
      isTextGenerationHfConfig(
        JSON.stringify({ architectures: ['BertModel'], model_type: 'bert' })
      )
    ).toBe(false)
  })

  it('rejects a sequence-classification head', () => {
    expect(
      isTextGenerationHfConfig(
        JSON.stringify({
          architectures: ['XLMRobertaForSequenceClassification'],
        })
      )
    ).toBe(false)
  })

  it('keeps a folder with a missing or unreadable config', () => {
    expect(isTextGenerationHfConfig(null)).toBe(true)
    expect(isTextGenerationHfConfig('{ not json')).toBe(true)
    expect(isTextGenerationHfConfig('{}')).toBe(true)
  })
})

describe('where each app keeps its models', () => {
  const home = '/Users/me'

  it('honours the environment override first and keeps the default too', () => {
    // A user who moved the store to a second disk and still has files at the
    // default location sees both; the override was invisible before ATO-458.
    expect(ollamaRoot(home, { OLLAMA_MODELS: '/mnt/models/ollama' })).toBe(
      '/mnt/models/ollama'
    )
    expect(ollamaRoot(home, {})).toBe('/Users/me/.ollama/models')

    expect(unslothRoot(home, { UNSLOTH_STUDIO_HOME: '/srv/unsloth' })).toBe(
      '/srv/unsloth'
    )
    expect(unslothRoot(home, { STUDIO_HOME: '/srv/studio' })).toBe('/srv/studio')
    expect(unslothRoot(home, {})).toBe('/Users/me/.unsloth/studio')
  })

  it('reads every spelling of the Hugging Face cache location', () => {
    expect(
      hfCacheRoots(home, {
        HF_HUB_CACHE: '/mnt/hf/hub',
        HF_HOME: '/mnt/hf-home',
        TRANSFORMERS_CACHE: '/mnt/legacy',
      })
    ).toEqual([
      '/mnt/hf/hub',
      '/mnt/hf-home/hub',
      '/mnt/legacy',
      '/Users/me/.cache/huggingface/hub',
    ])
    expect(hfCacheRoots(home, {})).toEqual([
      '/Users/me/.cache/huggingface/hub',
    ])
  })

  it('does not list the same root twice', () => {
    expect(
      hfCacheRoots(home, { HF_HUB_CACHE: '/Users/me/.cache/huggingface/hub' })
    ).toHaveLength(1)
  })

  it('places the app-data stores per OS', () => {
    expect(gpt4allRoots(home, {}, 'macos')).toEqual([
      '/Users/me/Library/Application Support/nomic.ai/GPT4All',
    ])
    expect(gpt4allRoots(home, {}, 'linux')).toEqual([
      '/Users/me/.local/share/nomic.ai/GPT4All',
    ])
    expect(
      gpt4allRoots(home, { XDG_DATA_HOME: '/data/xdg' }, 'linux')
    ).toEqual(['/data/xdg/nomic.ai/GPT4All'])

    expect(mstyRoots(home, {}, 'macos')).toEqual([
      '/Users/me/Library/Application Support/Msty/models',
    ])
    expect(mstyRoots(home, {}, 'linux')).toEqual(['/Users/me/.config/Msty/models'])
  })

  it('checks both the default Jan data folder and the app-data one', () => {
    expect(janRoots(home, {}, 'macos')).toEqual([
      '/Users/me/jan/models',
      '/Users/me/Library/Application Support/Jan/data/models',
    ])
  })

  it("finds llama.cpp's own -hf cache, and LLAMA_CACHE when set", () => {
    expect(llamaCppCacheRoots(home, {}, 'linux')).toEqual([
      '/Users/me/.cache/llama.cpp',
    ])
    expect(
      llamaCppCacheRoots(home, { LLAMA_CACHE: '/fast/llama' }, 'linux')
    ).toEqual(['/fast/llama', '/Users/me/.cache/llama.cpp'])
    expect(llamaCppCacheRoots(home, {}, 'macos')).toEqual([
      '/Users/me/Library/Caches/llama.cpp',
      '/Users/me/.cache/llama.cpp',
    ])
  })

  it('uses %LOCALAPPDATA% / %APPDATA% on Windows when they are set', () => {
    // The scanner runs with the host separator; these tests pin `/`, so the
    // assertion is on the segments rather than the joined string.
    const env = {
      LOCALAPPDATA: 'C:/Users/me/AppData/Local',
      APPDATA: 'C:/Users/me/AppData/Roaming',
    }
    expect(gpt4allRoots('C:/Users/me', env, 'windows')[0]).toContain(
      'AppData/Local/nomic.ai/GPT4All'
    )
    expect(mstyRoots('C:/Users/me', env, 'windows')[0]).toContain(
      'AppData/Roaming/Msty/models'
    )
    expect(llamaCppCacheRoots('C:/Users/me', env, 'windows')).toEqual([
      'C:/Users/me/AppData/Local/llama.cpp',
    ])
  })
})

// ATO-523: the reporter's HF cache held a quant, its projector and a 97 MB MTP
// head side by side, and the scan offered the head as a model of its own.
describe('scanLocalModels offers only runnable weights', () => {
  const repo = '/home/me/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF'
  const snapshot = `${repo}/snapshots/0a1b2c`

  beforeEach(() => {
    disk.files.clear()
  })

  it('lists the quant with its projector and leaves the MTP head out', async () => {
    disk.files.set(`${snapshot}/gemma-4-E2B-it-UD-Q4_K_XL.gguf`, {
      size: 3_200_000_000,
      arch: 'gemma4',
    })
    disk.files.set(`${snapshot}/mmproj-F16.gguf`, { size: 985_000_000 })
    // No readable metadata, so only the file name can give the head away.
    disk.files.set(`${snapshot}/mtp-gemma-4-E2B-it.gguf`, { size: 97_817_664 })

    const found = await scanLocalModels()

    expect(found.map(({ id, mmprojPath }) => ({ id, mmprojPath }))).toEqual([
      {
        id: 'unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-UD-Q4_K_XL',
        mmprojPath: `${snapshot}/mmproj-F16.gguf`,
      },
    ])
  })

  it('leaves out a head whose name gives nothing away, by its architecture', async () => {
    const cache = '/home/me/.cache/llama.cpp'
    disk.files.set(`${cache}/Qwen3-8B-Q4_K_M.gguf`, {
      size: 5_000_000_000,
      arch: 'qwen3',
    })
    disk.files.set(`${cache}/head-q8_0.gguf`, {
      size: 97_817_664,
      arch: 'gemma4-assistant',
    })
    disk.files.set(`${cache}/spec-q8_0.gguf`, { size: 1_000_000_000, arch: 'dflash' })

    const found = await scanLocalModels()

    expect(found.map((cand) => cand.displayName)).toEqual(['Qwen3-8B-Q4_K_M'])
  })
})
