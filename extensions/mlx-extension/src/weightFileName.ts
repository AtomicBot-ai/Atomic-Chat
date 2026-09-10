const DEFAULT_WEIGHT_FILE = 'model.safetensors'

/// Reject anything that could escape the model directory or hide the file;
/// a Hub weight name is always a plain `model*.safetensors`.
const SAFE_WEIGHT_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.safetensors$/i

/**
 * Local filename for the main weight file of an MLX download.
 *
 * The Hub flow hands us the first `*.safetensors` sibling of the repo, which
 * for a sharded checkpoint is `model-00001-of-000NN.safetensors`. Storing it
 * under a fixed `model.safetensors` orphans the shard that
 * `model.safetensors.index.json` points at, and the model then fails to load
 * with every shard-1 parameter reported missing.
 */
export function mlxMainWeightFileName(sourceUrl: string): string {
  const basename = sourceUrl.split(/[?#]/)[0].split('/').pop() ?? ''

  let decoded = basename
  try {
    decoded = decodeURIComponent(basename)
  } catch {
    /// Malformed percent-escape: keep the raw basename for the check below.
  }

  return SAFE_WEIGHT_FILE.test(decoded) ? decoded : DEFAULT_WEIGHT_FILE
}
