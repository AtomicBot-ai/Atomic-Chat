import { create } from 'zustand'

/**
 * The LiteRT-LM build this app session just installed or updated to, as `<version>/<platform>` —
 * the spelling of the accelerators answer's `build`. The provider page's NPU block prepares OpenVINO
 * once it sees that build on a host that offers it, then clears the mark: an install or update
 * prepares it once by itself (spec `litert-lm-desktop`), while a later visit prepares nothing.
 */
export const useLiteRtLmInstallStore = create<{ justInstalled: string | null }>(() => ({
  justInstalled: null,
}))
