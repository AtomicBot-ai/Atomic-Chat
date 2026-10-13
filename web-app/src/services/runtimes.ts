/**
 * Settings > Runtimes: the inference runtime catalog and the scan for runtimes
 * already running on this computer. Both come from the Rust side
 * (`src-tauri/src/core/runtimes/`); this file only types and sorts them.
 */
import { invoke } from '@tauri-apps/api/core'

export type RuntimeGroup =
  | 'local_desktop'
  | 'throughput_server'
  | 'model_library'
  | 'image_video_speech'
  | 'browser_mobile_edge'

export type RuntimeTier = 'p0' | 'p1' | 'p2' | 'p3' | 'deferred' | 'out_of_scope'

export type RuntimeMode =
  | 'bundled'
  | 'managed_install'
  | 'attach'
  | 'in_process'
  | 'wsl_hosted'
  | 'out_of_scope'

export type RuntimeLayer = 'engine' | 'wrapper' | 'library'
export type PlatformSupport = 'native' | 'wsl' | 'none'
export type Maintenance = 'active' | 'low_activity' | 'maintenance_mode' | 'archived'
export type LicenseClass = 'permissive' | 'copyleft' | 'proprietary'

export interface RuntimeDescriptor {
  id: string
  name: string
  group: RuntimeGroup
  tier: RuntimeTier
  mode: RuntimeMode
  layer: RuntimeLayer
  wraps: string[]
  capabilities: string[]
  formats: string[]
  apis: string[]
  default_port: number | null
  platforms: { windows: PlatformSupport; linux: PlatformSupport; macos: PlatformSupport }
  multi_gpu: string
  telemetry: Array<{ kind: string; path?: string; prefix?: string; needs_flag?: string | null }>
  granularity: string
  license: { spdx: string; class: LicenseClass }
  maintenance: Maintenance
  note: string
  verified: boolean
  verified_on: string
  source_url: string
}

export interface EngineCounters {
  prompt_tokens_total: number | null
  generated_tokens_total: number | null
  requests_running: number | null
  requests_waiting: number | null
  kv_cache_usage: number | null
}

export interface RuntimeDetection {
  baseUrl: string
  runtimeId: string | null
  confidence: 'confirmed' | 'port_guess'
  alternatives: string[]
  version: string | null
  models: string[]
  loadedModels: string[]
  devices: Array<{ name: string; vramTotalMib: number | null; vramFreeMib: number | null }>
  counters: EngineCounters | null
}

export function listRuntimes(): Promise<RuntimeDescriptor[]> {
  return invoke<RuntimeDescriptor[]>('runtimes_catalog')
}

/** Read-only scan of this computer's default runtime ports plus `extra` addresses. */
export function detectRuntimes(extra: string[] = []): Promise<RuntimeDetection[]> {
  return invoke<RuntimeDetection[]>('runtimes_detect', {
    endpoints: extra.map((baseUrl) => ({ baseUrl })),
  })
}

/** Phase order, as in the integration plan. */
export const TIER_ORDER: RuntimeTier[] = ['p0', 'p1', 'p2', 'p3', 'deferred', 'out_of_scope']

export interface RuntimeFilter {
  tier: RuntimeTier | 'all'
  query: string
}

/** Catalog rows matching the filter, in phase order then by name. */
export function filterRuntimes(
  runtimes: RuntimeDescriptor[],
  filter: RuntimeFilter
): RuntimeDescriptor[] {
  const query = filter.query.trim().toLowerCase()
  return runtimes
    .filter((runtime) => filter.tier === 'all' || runtime.tier === filter.tier)
    .filter(
      (runtime) =>
        !query ||
        runtime.name.toLowerCase().includes(query) ||
        runtime.id.includes(query) ||
        runtime.formats.some((format) => format.includes(query)) ||
        runtime.capabilities.some((capability) => capability.includes(query))
    )
    .sort(
      (a, b) =>
        TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
        a.name.localeCompare(b.name)
    )
}

export function countByTier(runtimes: RuntimeDescriptor[]): Record<RuntimeTier, number> {
  const counts = Object.fromEntries(TIER_ORDER.map((tier) => [tier, 0])) as Record<
    RuntimeTier,
    number
  >
  for (const runtime of runtimes) counts[runtime.tier] += 1
  return counts
}

/**
 * The name to show for a detection: the catalog name when the runtime is
 * known, otherwise the candidates for its port joined with "or".
 */
export function detectionName(
  detection: RuntimeDetection,
  byId: Map<string, RuntimeDescriptor>
): string {
  const name = (id: string) => byId.get(id)?.name ?? id
  if (detection.runtimeId) return name(detection.runtimeId)
  if (detection.alternatives.length > 0) return detection.alternatives.map(name).join(' or ')
  return 'OpenAI-compatible server'
}

/** Formats a token counter compactly: 1234 -> "1.2k". */
export function formatCount(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}
