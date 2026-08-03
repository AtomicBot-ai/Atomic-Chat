const LEGACY_WEIGHT_FILE = 'model.safetensors'

/// A shard rename that makes an existing checkpoint match its own index.
export type ShardRepairPlan = {
  from: string
  to: string
}

/**
 * Decide whether a model directory holds a mis-named first shard.
 *
 * Downloads made before the shard-naming fix stored the repo's first
 * `*.safetensors` sibling as a fixed `model.safetensors`, so a sharded
 * checkpoint ends up with the shard that `model.safetensors.index.json`
 * calls `model-00001-of-000NN.safetensors` sitting under the legacy name.
 * Loading then fails with every shard-1 parameter reported missing.
 *
 * Only the unambiguous case is repaired: exactly one indexed shard is absent
 * and the legacy file — which the index itself never references — is present.
 * Two or more absent shards mean an interrupted download, which no rename can
 * mend, so nothing is touched.
 */
export function planMlxShardRepair(
  weightMap: unknown,
  presentFiles: readonly string[]
): ShardRepairPlan | undefined {
  if (weightMap == null || typeof weightMap !== 'object') return undefined

  const shards = new Set(
    Object.values(weightMap as Record<string, unknown>).filter(
      (shard): shard is string => typeof shard === 'string' && shard.length > 0
    )
  )
  if (shards.size === 0 || shards.has(LEGACY_WEIGHT_FILE)) return undefined

  const present = new Set(presentFiles)
  if (!present.has(LEGACY_WEIGHT_FILE)) return undefined

  const absent = [...shards].filter((shard) => !present.has(shard))
  if (absent.length !== 1) return undefined

  return { from: LEGACY_WEIGHT_FILE, to: absent[0] }
}

/// Repoint a `model.yml` path that still names the legacy weight file at the
/// shard it was renamed to. Paths pointing anywhere else are left alone.
export function repointLegacyWeightPath(
  path: string,
  shardFileName: string
): string {
  const separator = path.slice(
    -LEGACY_WEIGHT_FILE.length - 1,
    -LEGACY_WEIGHT_FILE.length
  )
  if (
    !path.endsWith(LEGACY_WEIGHT_FILE) ||
    (separator !== '/' && separator !== '\\')
  ) {
    return path
  }
  return `${path.slice(0, -LEGACY_WEIGHT_FILE.length)}${shardFileName}`
}
