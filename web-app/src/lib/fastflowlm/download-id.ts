export const fastFlowLmDownloadId = (variant: string) =>
  `fastflowlm-${variant.replace(/[^A-Za-z0-9_-]/g, '_')}`
export const isFastFlowLmDownloadId = (id: string) =>
  id.startsWith('fastflowlm-')
