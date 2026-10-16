/**
 * Grouping, ordering and the advanced disclosure.
 *
 * Ordering is fully determined rather than "whatever the provider sent", so the
 * same model always draws the same form: known groups in a fixed order, unknown
 * groups after them alphabetically, `order` within a group, and the parameter
 * id as the final tiebreak. Two providers that disagree about ordering must
 * still each render deterministically.
 */

import { useState } from 'react'

import { visibleParams, type MediaParamSpec } from '@/services/media/contract'
import { MediaParamField } from './MediaParamField'
import { SizeInsight } from './SizeInsight'
import {
  DEFAULT_PARAM_GROUP,
  compareParamGroups,
  compareParamSpecs,
} from './paramIdentity'

export type MediaParamGroupsProps = {
  specs: MediaParamSpec[]
  values: Record<string, unknown>
  disabled?: boolean
  onChange: (id: string, value: unknown) => void
  onBlur: (id: string) => void
}

export function MediaParamGroups({
  specs,
  values,
  disabled,
  onChange,
  onBlur,
}: MediaParamGroupsProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  // The same visibility function `validateParams` uses, so what is drawn and
  // what is submitted can never disagree.
  const visible = visibleParams(specs, values)
  const plain = visible.filter((spec) => !spec.advanced)
  const advanced = visible.filter((spec) => spec.advanced)

  const groups = new Map<string, MediaParamSpec[]>()
  for (const spec of plain) {
    const group = spec.group ?? DEFAULT_PARAM_GROUP
    groups.set(group, [...(groups.get(group) ?? []), spec])
  }

  const ordered = [...groups.entries()].sort(([a], [b]) => compareParamGroups(a, b))

  return (
    <div className="flex flex-col gap-4">
      {ordered.map(([group, entries]) => (
        <section key={group} className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group}
          </h3>
          {[...entries].sort(compareParamSpecs).map((spec) => (
            <MediaParamField
              key={spec.id}
              spec={spec}
              value={values[spec.id]}
              disabled={disabled}
              onChange={onChange}
              onBlur={onBlur}
            />
          ))}
        </section>
      ))}

      {advanced.length > 0 ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className="self-start text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((open) => !open)}
          >
            {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          </button>
          {showAdvanced ? <SizeInsight specs={visible} values={values} /> : null}
          {showAdvanced
            ? [...advanced].sort(compareParamSpecs).map((spec) => (
                <MediaParamField
                  key={spec.id}
                  spec={spec}
                  value={values[spec.id]}
                  disabled={disabled}
                  onChange={onChange}
                  onBlur={onBlur}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  )
}
