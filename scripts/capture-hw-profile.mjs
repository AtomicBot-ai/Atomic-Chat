#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { cpus, freemem, platform, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIB = 1024 * 1024

function osType() {
  return { darwin: 'macos', win32: 'windows' }[platform()] ?? platform()
}

function macGpus() {
  if (platform() !== 'darwin') return []
  try {
    const raw = execFileSync(
      'system_profiler',
      ['SPDisplaysDataType', '-json'],
      { encoding: 'utf8' }
    )
    const displays = JSON.parse(raw).SPDisplaysDataType ?? []
    return displays.map((gpu, index) => ({
      name: gpu.sppci_model ?? `GPU ${index}`,
      total_memory: Number.parseInt(gpu.spdisplays_vram ?? '0', 10) || 0,
      vendor: gpu.spdisplays_vendor ?? 'Apple',
      uuid: `captured-gpu-${index}`,
      driver_version: '',
      vulkan_info: null,
      nvidia_info: null,
    }))
  } catch {
    return []
  }
}

export function captureHardwareProfile() {
  const cpuList = cpus()
  return {
    schema_version: 1,
    captured_from: {
      hostname: '<redacted>',
      note: 'Hostname is intentionally redacted from serialized output.',
    },
    system_info: {
      os_type: osType(),
      os_name: platform(),
      total_memory: Math.round(totalmem() / MIB),
      cpu: {
        name: cpuList[0]?.model ?? 'unknown',
        core_count: cpuList.length,
        arch: process.arch,
        extensions: [],
      },
      gpus: macGpus(),
    },
    system_usage: {
      used_memory: Math.round((totalmem() - freemem()) / MIB),
      total_memory: Math.round(totalmem() / MIB),
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const output = process.argv[2]
  if (!output) {
    console.error('usage: node scripts/capture-hw-profile.mjs <output.json>')
    process.exitCode = 2
  } else {
    const profile = captureHardwareProfile()
    writeFileSync(resolve(output), `${JSON.stringify(profile, null, 2)}\n`)
  }
}
