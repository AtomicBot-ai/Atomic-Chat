import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getProxyConfig,
  ggufShardSetPaths,
  isConcreteVersionBackend,
  isDownloadableUrl,
  classifyProjector,
} from './util'

// Mock console.log and console.error to avoid noise in tests
const mockConsole = {
  log: vi.fn(),
  error: vi.fn(),
}

// Set up mocks
beforeEach(() => {
  // Clear all mocks
  vi.clearAllMocks()

  // Clear localStorage mocks
  vi.mocked(localStorage.getItem).mockClear()

  // Mock console
  Object.defineProperty(console, 'log', {
    value: mockConsole.log,
    writable: true,
  })
  Object.defineProperty(console, 'error', {
    value: mockConsole.error,
    writable: true,
  })
})

describe('getProxyConfig', () => {
  it('should return null when no proxy configuration is stored', () => {
    vi.mocked(localStorage.getItem).mockReturnValue(null)

    const result = getProxyConfig()

    expect(result).toBeNull()
    expect(localStorage.getItem).toHaveBeenCalledWith('setting-proxy-config')
  })

  it('should return null when proxy is disabled', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: false,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: 'user',
        proxyPassword: 'pass',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: 'localhost,127.0.0.1',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toBeNull()
  })

  it('should return null when proxy is enabled but no URL is provided', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: '',
        proxyUsername: 'user',
        proxyPassword: 'pass',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toBeNull()
  })

  it('should return basic proxy configuration with SSL settings', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'https://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyIgnoreSSL: true,
        verifyProxySSL: false,
        verifyProxyHostSSL: false,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'https://proxy.example.com:8080',
      ignore_ssl: true,
      verify_proxy_ssl: false,
      verify_proxy_host_ssl: false,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })

  it('should include authentication when both username and password are provided', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: 'testuser',
        proxyPassword: 'testpass',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'http://proxy.example.com:8080',
      username: 'testuser',
      password: 'testpass',
      ignore_ssl: false,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })

  it('should not include authentication when only username is provided', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: 'testuser',
        proxyPassword: '',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'http://proxy.example.com:8080',
      ignore_ssl: false,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
    expect(result?.username).toBeUndefined()
    expect(result?.password).toBeUndefined()
  })

  it('should not include authentication when only password is provided', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: 'testpass',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'http://proxy.example.com:8080',
      ignore_ssl: false,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
    expect(result?.username).toBeUndefined()
    expect(result?.password).toBeUndefined()
  })

  it('should parse no_proxy list correctly', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: 'localhost, 127.0.0.1, *.example.com , specific.domain.com',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'http://proxy.example.com:8080',
      no_proxy: [
        'localhost',
        '127.0.0.1',
        '*.example.com',
        'specific.domain.com',
      ],
      ignore_ssl: false,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })

  it('should handle empty no_proxy entries', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: 'localhost, , 127.0.0.1, ,',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'http://proxy.example.com:8080',
      no_proxy: ['localhost', '127.0.0.1'],
      ignore_ssl: false,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })

  it('should handle mixed SSL verification settings', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'https://proxy.example.com:8080',
        proxyUsername: 'user',
        proxyPassword: 'pass',
        proxyIgnoreSSL: true,
        verifyProxySSL: false,
        verifyProxyHostSSL: true,
        verifyPeerSSL: false,
        verifyHostSSL: true,
        noProxy: 'localhost',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'https://proxy.example.com:8080',
      username: 'user',
      password: 'pass',
      no_proxy: ['localhost'],
      ignore_ssl: true,
      verify_proxy_ssl: false,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: false,
      verify_host_ssl: true,
    })
  })

  it('should handle all SSL verification settings as false', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyIgnoreSSL: false,
        verifyProxySSL: false,
        verifyProxyHostSSL: false,
        verifyPeerSSL: false,
        verifyHostSSL: false,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'http://proxy.example.com:8080',
      ignore_ssl: false,
      verify_proxy_ssl: false,
      verify_proxy_host_ssl: false,
      verify_peer_ssl: false,
      verify_host_ssl: false,
    })
  })

  it('should handle all SSL verification settings as true', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'https://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyIgnoreSSL: true,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'https://proxy.example.com:8080',
      ignore_ssl: true,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })

  it('should log proxy configuration details', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'https://proxy.example.com:8080',
        proxyUsername: 'testuser',
        proxyPassword: 'testpass',
        proxyIgnoreSSL: true,
        verifyProxySSL: false,
        verifyProxyHostSSL: true,
        verifyPeerSSL: false,
        verifyHostSSL: true,
        noProxy: 'localhost,127.0.0.1',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    getProxyConfig()

    expect(mockConsole.log).toHaveBeenCalledWith('Using proxy configuration:', {
      url: 'https://proxy.example.com:8080',
      hasAuth: true,
      noProxyCount: 2,
      ignoreSSL: true,
      verifyProxySSL: false,
      verifyProxyHostSSL: true,
      verifyPeerSSL: false,
      verifyHostSSL: true,
    })
  })

  it('should log proxy configuration without authentication', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'http://proxy.example.com:8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    getProxyConfig()

    expect(mockConsole.log).toHaveBeenCalledWith('Using proxy configuration:', {
      url: 'http://proxy.example.com:8080',
      hasAuth: false,
      noProxyCount: 0,
      ignoreSSL: false,
      verifyProxySSL: true,
      verifyProxyHostSSL: true,
      verifyPeerSSL: true,
      verifyHostSSL: true,
    })
  })

  it('should return null and log error when JSON parsing fails', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('invalid-json')

    const result = getProxyConfig()

    expect(result).toBeNull()
    expect(mockConsole.error).toHaveBeenCalledWith(
      'Failed to parse proxy configuration:',
      expect.any(SyntaxError)
    )
  })

  it('should handle SOCKS proxy URLs', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'socks5://proxy.example.com:1080',
        proxyUsername: 'user',
        proxyPassword: 'pass',
        proxyIgnoreSSL: false,
        verifyProxySSL: true,
        verifyProxyHostSSL: true,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: '',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'socks5://proxy.example.com:1080',
      username: 'user',
      password: 'pass',
      ignore_ssl: false,
      verify_proxy_ssl: true,
      verify_proxy_host_ssl: true,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })

  it('should handle comprehensive proxy configuration', () => {
    const proxyConfig = {
      state: {
        proxyEnabled: true,
        proxyUrl: 'https://secure-proxy.example.com:8443',
        proxyUsername: 'admin',
        proxyPassword: 'secretpass',
        proxyIgnoreSSL: true,
        verifyProxySSL: false,
        verifyProxyHostSSL: false,
        verifyPeerSSL: true,
        verifyHostSSL: true,
        noProxy: 'localhost,127.0.0.1,*.local,192.168.1.0/24',
      },
      version: 0,
    }

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(proxyConfig))

    const result = getProxyConfig()

    expect(result).toEqual({
      url: 'https://secure-proxy.example.com:8443',
      username: 'admin',
      password: 'secretpass',
      no_proxy: ['localhost', '127.0.0.1', '*.local', '192.168.1.0/24'],
      ignore_ssl: true,
      verify_proxy_ssl: false,
      verify_proxy_host_ssl: false,
      verify_peer_ssl: true,
      verify_host_ssl: true,
    })
  })
})

describe('isConcreteVersionBackend (ATO-124)', () => {
  it('accepts a concrete <tag>/<backend>', () => {
    expect(isConcreteVersionBackend('b9562/win-cpu-x64')).toBe(true)
  })

  it('rejects the unresolved latest/<backend> sentinel', () => {
    expect(isConcreteVersionBackend('latest/win-cpu-x64')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isConcreteVersionBackend('')).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isConcreteVersionBackend(undefined)).toBe(false)
  })

  it('rejects null', () => {
    expect(isConcreteVersionBackend(null)).toBe(false)
  })

  it("rejects the literal 'none'", () => {
    expect(isConcreteVersionBackend('none')).toBe(false)
  })

  it('rejects a value with no slash', () => {
    expect(isConcreteVersionBackend('b9562')).toBe(false)
  })

  it('rejects the literal "latest" (no slash)', () => {
    expect(isConcreteVersionBackend('latest')).toBe(false)
  })

  it('strips a leading BOM before checking a concrete value', () => {
    expect(isConcreteVersionBackend('\uFEFFb9562/win-cpu-x64')).toBe(true)
  })

  it('strips a BOM that precedes the latest sentinel and still rejects', () => {
    expect(isConcreteVersionBackend('\uFEFFlatest/win-cpu-x64')).toBe(false)
  })

  it('trims surrounding whitespace around a concrete value', () => {
    expect(isConcreteVersionBackend('  b9562/linux-cpu-x64  ')).toBe(true)
  })

  it('trims whitespace around the latest sentinel and still rejects', () => {
    expect(isConcreteVersionBackend('  latest/linux-cpu-x64  ')).toBe(false)
  })

  it('rejects whitespace-only input', () => {
    expect(isConcreteVersionBackend('   ')).toBe(false)
  })
})

describe('GGUF shard paths', () => {
  it('treats an unsharded model as standalone', () => {
    expect(ggufShardSetPaths('models/author/Model-Q4_K_M/model.gguf')).toEqual([
      'models/author/Model-Q4_K_M/model.gguf',
    ])
  })

  it('expands a shard into the whole set, first shard first', () => {
    expect(
      ggufShardSetPaths(
        'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00003-of-00003.gguf'
      )
    ).toEqual([
      'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00001-of-00003.gguf',
      'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00002-of-00003.gguf',
      'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00003-of-00003.gguf',
    ])
  })

  it('expands a shard laid out on disk, where the marker is in the folder', () => {
    expect(
      ggufShardSetPaths('models/unsloth/BF16/Qwen3-BF16-00002-of-00002/model.gguf')
    ).toEqual([
      'models/unsloth/BF16/Qwen3-BF16-00001-of-00002/model.gguf',
      'models/unsloth/BF16/Qwen3-BF16-00002-of-00002/model.gguf',
    ])
  })

  it('treats a malformed marker as no marker', () => {
    expect(ggufShardSetPaths('Model-00000-of-00003.gguf')).toEqual(['Model-00000-of-00003.gguf'])
    expect(ggufShardSetPaths('Model-00004-of-00003.gguf')).toEqual(['Model-00004-of-00003.gguf'])
  })
})

describe('classifyProjector', () => {
  it('recognises an audio projector', () => {
    // Voxtral's mmproj, as libmtmd writes it. `read_gguf_metadata` renders
    // GGUF booleans as the strings "true"/"false".
    expect(
      classifyProjector({
        'general.architecture': 'clip',
        'clip.has_audio_encoder': 'true',
        'clip.audio.projector_type': 'voxtral',
      })
    ).toEqual({ vision: false, audio: true })
  })

  it('recognises a vision projector', () => {
    expect(
      classifyProjector({
        'general.architecture': 'clip',
        'clip.has_vision_encoder': 'true',
        'clip.vision.projector_type': 'gemma3',
      })
    ).toEqual({ vision: true, audio: false })
  })

  it('recognises a projector that carries both modalities', () => {
    expect(
      classifyProjector({
        'clip.has_vision_encoder': 'true',
        'clip.has_audio_encoder': 'true',
      })
    ).toEqual({ vision: true, audio: true })
  })

  it('falls back to vision for metadata it cannot classify', () => {
    // Regression guard: before this function existed every mmproj was treated
    // as vision, and a projector we fail to read must not lose that.
    expect(classifyProjector({})).toEqual({ vision: true, audio: false })
    expect(classifyProjector(undefined)).toEqual({ vision: true, audio: false })
    expect(classifyProjector(null)).toEqual({ vision: true, audio: false })
    expect(classifyProjector({ 'general.architecture': 'clip' })).toEqual({
      vision: true,
      audio: false,
    })
  })

  it('does not treat a false flag as present', () => {
    expect(
      classifyProjector({
        'clip.has_vision_encoder': 'true',
        'clip.has_audio_encoder': 'false',
      })
    ).toEqual({ vision: true, audio: false })
  })

  it('tolerates real booleans as well as strings', () => {
    expect(
      classifyProjector({
        'clip.has_audio_encoder': true,
        'clip.has_vision_encoder': false,
      })
    ).toEqual({ vision: false, audio: true })
  })

  it('ignores an empty projector-type string', () => {
    expect(
      classifyProjector({
        'clip.vision.projector_type': '',
        'clip.audio.projector_type': '  ',
      })
    ).toEqual({ vision: true, audio: false })
  })
})

describe('isDownloadableUrl', () => {
  it('takes any https address as something to download', () => {
    expect(isDownloadableUrl('https://huggingface.co/org/repo/resolve/main/m.gguf')).toBe(true)
    expect(isDownloadableUrl('https://mirror.example/m.gguf')).toBe(true)
  })

  it('takes plain http only from this machine', () => {
    expect(isDownloadableUrl('http://127.0.0.1:8080/m.gguf')).toBe(true)
    expect(isDownloadableUrl('http://localhost:8080/m.gguf')).toBe(true)
    expect(isDownloadableUrl('http://LOCALHOST/m.gguf')).toBe(true)
    expect(isDownloadableUrl('http://[::1]:8080/m.gguf')).toBe(true)
  })

  it('does not take plain http from anywhere else, however local it looks', () => {
    expect(isDownloadableUrl('http://mirror.example/m.gguf')).toBe(false)
    expect(isDownloadableUrl('http://192.168.1.10/m.gguf')).toBe(false)
    expect(isDownloadableUrl('http://127.0.0.1.evil.example/m.gguf')).toBe(false)
    expect(isDownloadableUrl('http://localhost.evil.example/m.gguf')).toBe(false)
    expect(isDownloadableUrl('http://user@127.0.0.1@evil.example/m.gguf')).toBe(false)
  })

  it('leaves paths on disk and nonsense to the local-file branch', () => {
    expect(isDownloadableUrl('/Users/me/models/m.gguf')).toBe(false)
    expect(isDownloadableUrl('C:\\models\\m.gguf')).toBe(false)
    expect(isDownloadableUrl('ftp://127.0.0.1/m.gguf')).toBe(false)
    expect(isDownloadableUrl('http://')).toBe(false)
    expect(isDownloadableUrl('')).toBe(false)
  })
})
