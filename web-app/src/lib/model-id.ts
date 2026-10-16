/** Extract a quantization token from a model id (e.g. `Q4_K_M`, `IQ4_XS`, `4bit`). */
export function quantFromModelId(modelId?: string | null): string | null {
  if (!modelId) return null
  const match = modelId.match(
    /\b(IQ\d+_[A-Z0-9]+|Q\d+_[A-Z0-9_]+|Q\d+|MXFP\d+|\d+bit|bf16|fp16|fp8|f16|f32)\b/i
  )
  return match ? match[1] : null
}
