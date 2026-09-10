import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { captureHardwareProfile } from '../scripts/capture-hw-profile.mjs'

const profiles = JSON.parse(
  readFileSync(
    new URL('./fixtures/hardware/profiles.json', import.meta.url),
    'utf8'
  )
)

test('hardware fixtures match the Rust SystemInfo serialization contract', () => {
  for (const { name, system_info: info } of profiles) {
    assert.ok(['macos', 'windows', 'linux'].includes(info.os_type), name)
    assert.ok(info.total_memory > 0, name)
    assert.ok(info.cpu.core_count > 0, name)
    assert.ok(['x86_64', 'arm64'].includes(info.cpu.arch), name)
    assert.ok(Array.isArray(info.cpu.extensions), name)
    for (const gpu of info.gpus) {
      assert.ok(gpu.total_memory >= 0, name)
      assert.equal(typeof gpu.uuid, 'string', name)
      assert.ok('nvidia_info' in gpu, name)
      assert.ok('vulkan_info' in gpu, name)
    }
  }
})

test('backend expectation table encodes provider-specific platform policy', () => {
  const windows = profiles.find(
    ({ name }) => name === 'windows-x64-nvidia-cuda13'
  )
  assert.equal(windows.expected.turboquant, 'windows-x64-cuda-13.3')
  assert.equal(windows.expected.upstream, 'win-cuda-13.3-x64')

  const linux = profiles.find(({ name }) => name === 'linux-x64-nvidia-vulkan')
  assert.equal(linux.expected.turboquant, 'linux-x64-vulkan')
  assert.equal(linux.expected.upstream, 'linux-vulkan-x64')
  assert.ok(!linux.expected.upstream.includes('cuda'))

  const integrated = profiles.find(
    ({ name }) => name === 'linux-x64-integrated-vulkan'
  )
  assert.equal(integrated.expected.turboquant, 'cpu-optimal')
  assert.equal(integrated.expected.upstream, 'cpu-optimal')
})

// Windows is the one platform where upstream publishes a HIP archive, and the
// card decides: an RDNA3 board is in the generated PCI table and gets ROCm,
// while GCN (Vega) is not and stays on Vulkan. TurboQuant ships no Windows
// ROCm build at all, so it stays on Vulkan for both.
test('AMD Windows hosts are split by the generated ROCm PCI table', () => {
  const rdna3 = profiles.find(
    ({ name }) => name === 'windows-x64-amd-rdna3-rocm'
  )
  assert.equal(rdna3.features.rocm, true)
  assert.match(rdna3.expected.upstream, /^win-rocm-\d+\.\d+-x64$/)
  assert.equal(rdna3.expected.turboquant, 'windows-x64-vulkan')

  const vega = profiles.find(({ name }) => name === 'windows-x64-amd-vega-vulkan')
  assert.equal(vega.features.rocm, false)
  assert.equal(vega.expected.upstream, 'win-vulkan-x64')
  assert.equal(vega.expected.turboquant, 'windows-x64-vulkan')

  // The gate reads the PCI device id, so every AMD profile must carry one.
  for (const profile of [rdna3, vega]) {
    const [gpu] = profile.system_info.gpus
    assert.equal(gpu.vendor, 'AMD', profile.name)
    assert.ok(Number.isInteger(gpu.vulkan_info.device_id), profile.name)
  }
})

test('capture script emits a serializable profile without network access', () => {
  const captured = captureHardwareProfile()
  assert.equal(captured.schema_version, 1)
  assert.ok(captured.system_info.total_memory > 0)
  assert.ok(captured.system_info.cpu.core_count > 0)
  assert.doesNotThrow(() => JSON.stringify(captured))
})
