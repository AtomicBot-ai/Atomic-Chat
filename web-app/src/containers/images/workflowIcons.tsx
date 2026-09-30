import {
  IconArrowsDiagonal,
  IconBrush,
  IconPencil,
  IconPhotoUp,
  IconSparkles,
  IconWand,
  IconZoomScan,
  type IconProps,
} from '@tabler/icons-react'
import type { ComponentType } from 'react'

import type { ImageWorkflowId } from '@/services/diffusion/types'

/** One icon per workflow, shared by the sidebar rows and the form heading. */
export const WORKFLOW_ICONS: Record<ImageWorkflowId, ComponentType<IconProps>> = {
  create: IconSparkles,
  transform: IconWand,
  inpaint: IconBrush,
  extend: IconArrowsDiagonal,
  upscale: IconZoomScan,
  reference: IconPhotoUp,
  edit: IconPencil,
}
