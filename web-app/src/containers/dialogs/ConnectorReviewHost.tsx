import { ConnectorReviewDialog } from '@/containers/ConnectorReviewDialog'
import { useConnectorReview } from '@/hooks/useConnectorReview'
import { useServiceHub } from '@/hooks/useServiceHub'

/**
 * Shows the review (Allow / Preview / Cancel) for the oldest connector waiting
 * in useConnectorReview. Mounted once at the app root, so every screen that
 * switches a connector on gets the same review.
 */
export default function ConnectorReviewHost() {
  const serviceHub = useServiceHub()
  const request = useConnectorReview((state) => state.pending[0])
  const settle = useConnectorReview((state) => state.settle)

  if (!request) return null

  return (
    <ConnectorReviewDialog
      // A fresh dialog per connector, so one Preview never shows in the next.
      key={request.id}
      open
      name={request.name}
      config={request.config}
      onListTools={() =>
        serviceHub.mcp().previewConnectorTools(request.name, request.config)
      }
      onAllow={() => settle(request.id, true)}
      onCancel={() => settle(request.id, false)}
    />
  )
}
