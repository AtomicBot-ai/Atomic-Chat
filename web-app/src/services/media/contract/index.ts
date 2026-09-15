/**
 * Media contract v2 — the app-wide seam between the Media surface and any
 * media provider.
 *
 * This module is types plus one pure function (`validateParams`). It adds no
 * runtime behaviour, performs no I/O, imports nothing from React, and does not
 * depend on `@/services/atomicMedia`, which is v1 and becomes the Radium Media
 * Worker adapter's private implementation detail.
 */

export {
  MEDIA_TASK,
  type MediaOutputMediaType,
  type MediaTaskId,
  type MediaTaskPresentation,
} from './tasks'

export {
  MEDIA_MAX_GENERATED_SEED,
  resolveSeeds,
  validateParams,
  visibleParams,
  type MediaParamDependency,
  type MediaParamModulus,
  type MediaParamOption,
  type MediaParamSpec,
  type MediaParamType,
  type MediaParamValidationError,
  type MediaParamValidationErrorCode,
  type MediaParamValidationResult,
} from './params'

export {
  MEDIA_CONTRACT_MAX_SUPPORTED,
  MEDIA_CONTRACT_MIN_SUPPORTED,
  MEDIA_CONTRACT_VERSION,
  type MediaCapabilities,
  type MediaDeviceDescriptor,
  type MediaFitness,
  type MediaFitnessStatus,
  type MediaInstallState,
  type MediaModelDescriptor,
  type MediaModelQuant,
  type MediaDownloadFile,
  type MediaProviderFeatures,
} from './models'

export { downcastV2Request, upcastV1Capabilities } from './upcast'

export {
  type MediaJobError,
  type MediaJobHandle,
  type MediaJobSnapshot,
  type MediaJobState,
  type MediaOutputRef,
  type MediaProviderAdapter,
  type MediaProviderAdapterId,
  type MediaProviderDescriptor,
  type MediaProviderHealth,
  type MediaProviderKind,
  type NormalizedMediaRequest,
} from './jobs'
