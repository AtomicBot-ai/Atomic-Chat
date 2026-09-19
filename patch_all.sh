#!/bin/bash
# Apply upstreamCudaBackendId test
sed -i "s/describe('TurboQuant cudart helpers'/describe('upstreamCudaBackendId', () => {\n  it('formats strings for typical CUDA versions', () => {\n    expect(upstreamCudaBackendId('13.3')).toBe('win-cuda-13.3-x64')\n    expect(upstreamCudaBackendId('12.4')).toBe('win-cuda-12.4-x64')\n    expect(upstreamCudaBackendId('11.8')).toBe('win-cuda-11.8-x64')\n  })\n\n  it('handles edge cases safely', () => {\n    expect(upstreamCudaBackendId('')).toBe('win-cuda--x64')\n    expect(upstreamCudaBackendId('invalid')).toBe('win-cuda-invalid-x64')\n  })\n})\n\ndescribe('TurboQuant cudart helpers'/" extensions/llamacpp-extension/src/test/backend.test.ts

# Apply ipc contract fix
sed -i "s/'media_secret_available',/'media_engine_install',\n  'media_engine_start',\n  'media_engine_status',\n  'media_engine_stop',\n  'media_secret_available',/" web-app/src/lib/__tests__/ipc-contract.test.ts

# Apply useRecommendedLocalModel.ts fix
sed -i 's/resumableDownloads.has(variant.model_id)/resumableDownloads.has(variant.model_id),\n        model/' web-app/src/hooks/useRecommendedLocalModel.ts

# Apply PromptOnboardingModel.test.tsx fix
sed -i 's/false,/false/' web-app/src/containers/__tests__/PromptOnboardingModel.test.tsx
sed -i 's/false\n      \],/false,\n        catalogModel\n      \],/' web-app/src/containers/__tests__/PromptOnboardingModel.test.tsx

# Apply ReplyModelGate.test.tsx fix
sed -i 's/false,/false/' web-app/src/containers/__tests__/ReplyModelGate.test.tsx
sed -i "s/false\n    )/false,\n      catalogModel\n    )/" web-app/src/containers/__tests__/ReplyModelGate.test.tsx

# Apply ModelDownloadAction.test.tsx fix
sed -i 's/false,/false/' web-app/src/containers/__tests__/ModelDownloadAction.test.tsx
