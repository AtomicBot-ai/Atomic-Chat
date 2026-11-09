/** FastFlowLM's separate preparation and maintenance protocol, through the authenticated Rust relay. */
import { invoke } from '@tauri-apps/api/core'
import type {
  FastFlowLmCheckRequest,
  FastFlowLmCheckResult,
  FastFlowLmConsent,
  FastFlowLmMaintenance,
  FastFlowLmMaintenanceRequest,
  FastFlowLmMaintenanceResult,
  FastFlowLmOperation,
  FastFlowLmProbePlan,
} from '@atomic-chat/core/contracts'

function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown = null
): Promise<T> {
  return invoke('atomic_core_call', { method, path, body })
}
const operations = '/runtimes/fastflowlm/operations'
const maintenance = '/models/fastflowlm/maintenance'
const operationPath = (id: string) => `${operations}/${encodeURIComponent(id)}`
const maintenancePath = (id: string) =>
  `${maintenance}/${encodeURIComponent(id)}`

export const probeFastFlowLm = () =>
  call<FastFlowLmProbePlan>('POST', '/runtimes/fastflowlm/probe', {})
export const checkFastFlowLmModel = (request: FastFlowLmCheckRequest) =>
  call<FastFlowLmCheckResult>('POST', '/models/fastflowlm/check', request)
export const fastFlowLmOperations = () =>
  call<FastFlowLmOperation[]>('GET', operations)
export const fastFlowLmOperation = (id: string) =>
  call<FastFlowLmOperation>('GET', operationPath(id))
export const beginFastFlowLmPreparation = (requestId: string) =>
  call<FastFlowLmOperation>('POST', operations, { request_id: requestId })
export const consentFastFlowLmPreparation = (
  id: string,
  consent: FastFlowLmConsent
) => call<FastFlowLmOperation>('POST', `${operationPath(id)}/consent`, consent)
export const resumeFastFlowLmPreparation = (
  id: string,
  expectedRevision: number
) =>
  call<FastFlowLmOperation>('POST', `${operationPath(id)}/resume`, {
    expected_revision: expectedRevision,
  })
export const cancelFastFlowLmPreparation = (id: string) =>
  call<FastFlowLmOperation>('POST', `${operationPath(id)}/cancel`, {})
export const listFastFlowLmMaintenance = () =>
  call<FastFlowLmMaintenance[]>('GET', maintenance)
export const fastFlowLmMaintenance = (id: string) =>
  call<FastFlowLmMaintenance>('GET', maintenancePath(id))
export const beginFastFlowLmMaintenance = (
  request: FastFlowLmMaintenanceRequest
) => call<FastFlowLmMaintenanceResult>('POST', maintenance, request)
export const completeFastFlowLmMaintenance = (id: string) =>
  call<FastFlowLmMaintenance>('POST', `${maintenancePath(id)}/complete`, {})
