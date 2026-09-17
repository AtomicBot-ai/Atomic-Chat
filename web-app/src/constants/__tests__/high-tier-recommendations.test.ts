import { describe, expect, it } from 'vitest'
import {
  BASELINE_TIER_RECOMMENDATIONS,
  RECOMMENDATION_LADDER,
  RECOMMENDED_MODEL_FALLBACKS,
} from '../models'
import {
  describeHardware,
  judgeMemoryFit,
  type HardwareTier,
} from '@/lib/hardware-tier'
import {
  findPinnedQuant,
  parseFileSizeToBytes,
  quantLabel,
} from '@/lib/model-card'
import { ggufShardGroupKey } from '@/lib/models'
import evidence from './fixtures/high-tier-files.json'

const cases = [
  ['64', 64, 'AtomicChat/Qwen3.6-35B-A3B-GGUF', 'Q6_K', 'Q4_K_M'],
  ['64_plus', 96, 'Qwen/Qwen3-Coder-Next-GGUF', 'Q4_K_M', 'Q6_K'],
  ['128', 128, 'unsloth/gpt-oss-120b-GGUF', 'Q8_0', 'Q8_0'],
  [
    '128_plus',
    192,
    'unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF',
    'Q4_K_M',
    'Q8_0',
  ],
] as const
const visionRepo = 'AtomicChat/gemma-4-31B-it-GGUF'

describe('high-memory recommendation downloads', () => {
  it.each(cases)(
    'offers the %s lead, alternatives and pinned vision offline',
    (suffix, size, repo, pin, visionPin) => {
      for (const pool of ['unified', 'vram'] as const) {
        const tier = `${pool}_${suffix}` as HardwareTier
        const recs = BASELINE_TIER_RECOMMENDATIONS[tier]
        expect(recs[0]).toMatchObject({ model_name: repo, quant: pin })
        expect(recs.length).toBeGreaterThanOrEqual(3)
        expect(new Set(recs.map((r) => r.model_name)).size).toBe(recs.length)
        expect(recs).toContainEqual({
          model_name: visionRepo,
          quant: visionPin,
          mmproj_quant: 'F16',
          description_key: 'hub:recVisionKnowledge',
        })
        const profile = describeHardware(
          pool === 'unified'
            ? { os_type: 'macos', total_memory: size * 1024 }
            : { os_type: 'windows', gpus: [{ total_memory: size * 1024 }] }
        )
        for (const rec of recs) {
          const card = RECOMMENDED_MODEL_FALLBACKS[rec.model_name]
          expect(card, rec.model_name).toBeDefined()
          const quant = findPinnedQuant(card.quants, rec.quant)
          expect(quant, rec.quant).toBeDefined()
          const modelEvidence = evidence.models.find(
            (m) => m.repo === rec.model_name
          )!
          const files = modelEvidence.quants.find(
            (q) => q.pin === rec.quant
          )!.files
          const weightsBytes = files.reduce((sum, f) => sum + f.size, 0)
          expect(quant!.path).toBe(
            `https://huggingface.co/${rec.model_name}/resolve/main/${files[0].path}`
          )
          // The first shard is the download entry point; size covers ALL shards.
          expect(
            parseFileSizeToBytes(quant!.file_size)! / 1024 ** 3
          ).toBeCloseTo(weightsBytes / 1024 ** 3, 2)
          expect(
            quantLabel(ggufShardGroupKey(files[0].path).replace(/\.gguf$/, ''))
          ).toBe(rec.quant)
          let projectorBytes = 0
          if (rec.mmproj_quant) {
            const projector = findPinnedQuant(
              card.mmproj_models,
              rec.mmproj_quant
            )!
            const proof = modelEvidence.projectors.find(
              (p) => p.pin === rec.mmproj_quant
            )!
            expect(projector.path).toBe(
              `https://huggingface.co/${rec.model_name}/resolve/main/${proof.path}`
            )
            expect(
              parseFileSizeToBytes(projector.file_size)! / 1024 ** 3
            ).toBeCloseTo(proof.size / 1024 ** 3, 2)
            projectorBytes = proof.size
          }
          expect(['comfortable', 'tight']).toContain(
            judgeMemoryFit(weightsBytes + projectorBytes, profile)
          )
        }
        const lead = RECOMMENDED_MODEL_FALLBACKS[repo]
        const leadBytes = parseFileSizeToBytes(
          findPinnedQuant(lead.quants, pin)!.file_size
        )!
        expect(RECOMMENDATION_LADDER[tier].sizeGb).toBeCloseTo(
          leadBytes / 1024 ** 3,
          2
        )
      }
    }
  )

  it.each([
    ['64', 48.5],
    ['64_plus', 64.5],
    ['128', 127.5],
    ['128_plus', 128.5],
  ] as const)(
    'keeps every %s option within the Metal ceiling at the lower edge',
    (suffix, size) => {
      const profile = describeHardware({
        os_type: 'macos',
        total_memory: size * 1024,
      })
      for (const rec of BASELINE_TIER_RECOMMENDATIONS[`unified_${suffix}`]) {
        const proof = evidence.models.find((m) => m.repo === rec.model_name)!
        const weights = proof.quants
          .find((q) => q.pin === rec.quant)!
          .files.reduce((s, f) => s + f.size, 0)
        const projector = rec.mmproj_quant
          ? proof.projectors.find((p) => p.pin === rec.mmproj_quant)!.size
          : 0
        expect(['comfortable', 'tight']).toContain(
          judgeMemoryFit(weights + projector, profile)
        )
      }
    }
  )
})
