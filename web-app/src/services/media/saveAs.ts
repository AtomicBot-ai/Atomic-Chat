import { getServiceHub } from '@/hooks/useServiceHub'
import { suggestedFileName, type MediaAsset } from './assets'

/** Save a copy wherever the user chooses, under a name they can edit. */
export async function saveMediaAssetAs(asset: MediaAsset): Promise<string | null> {
  const hub = getServiceHub()
  const fileName = suggestedFileName(asset)
  const extension = fileName.split('.').pop() ?? ''
  const destination = await hub.dialog().save({
    defaultPath: fileName,
    filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
  })
  if (!destination) return null
  await hub.core().invoke('copy_file', { src: asset.path, dest: destination })
  return destination
}
