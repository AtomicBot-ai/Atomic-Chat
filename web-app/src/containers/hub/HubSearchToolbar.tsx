import type { ReactNode } from 'react'
import HeaderPage from '@/containers/HeaderPage'
import { HubSearchInput } from '@/containers/hub/HubSearch'
import { ImportLocalFile } from '@/containers/hub/ImportLocalFile'
import './hub.css'

export type HubSearchToolbarProps = {
  value: string
  onChange: (value: string) => void
  placeholder: string
  busy?: boolean
  /** The model type picker, first in the row. */
  modelType?: ReactNode
  /** The category's own controls after the search field (Filters, Sort). */
  controls?: ReactNode
}

/**
 * The Hub's one toolbar row, the same in every category: model type, the
 * search field taking the spare width, the category's controls, and Import.
 */
export function HubSearchToolbar({
  value,
  onChange,
  placeholder,
  busy = false,
  modelType,
  controls,
}: HubSearchToolbarProps) {
  return (
    <HeaderPage className="hub-toolbar-header">
      <div className="hub-search-toolbar flex w-full min-w-0 items-center gap-2">
        {modelType && <div className="hub-model-type">{modelType}</div>}
        <div className="hub-search-field flex min-w-0 items-center gap-2 rounded-full border border-input bg-input/20 px-3">
          <HubSearchInput
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            busy={busy}
          />
        </div>
        {controls}
        <span className="ml-1 shrink-0 border-l border-border pl-3 empty:hidden">
          <ImportLocalFile />
        </span>
      </div>
    </HeaderPage>
  )
}
