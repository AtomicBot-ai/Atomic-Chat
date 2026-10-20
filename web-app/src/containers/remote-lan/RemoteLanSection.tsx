import { useLanAccess } from '@/hooks/useLanAccess'
import {
  type LocalApiServerControl,
  useRemoteAccess,
} from '@/hooks/useRemoteAccess'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

import { LanAccessCard } from './LanAccessCard'
import { RemoteAccessCard } from './RemoteAccessCard'

/**
 * Server → Remote access: the Cloudflare tunnel above, the local network
 * below.
 *
 * `server` is the page's own control: each control re-checks the server on
 * focus and owns a "loading model" flag, and both cards start and stop the
 * server through the same one so they agree on both.
 */
export function RemoteLanSection({
  server,
}: {
  server: LocalApiServerControl
}) {
  const remote = useRemoteAccess({ server })
  const lan = useLanAccess({ server, hasApiKey: remote.hasApiKey })
  const remoteAccess = PlatformFeatures[PlatformFeature.REMOTE_ACCESS]

  return (
    <div>
      {remoteAccess && <RemoteAccessCard remote={remote} />}
      <LanAccessCard lan={lan} />
    </div>
  )
}
