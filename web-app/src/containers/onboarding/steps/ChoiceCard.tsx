import { ArrowRight } from 'lucide-react'

import './choices.css'

/**
 * One of the large choices the purpose and server steps offer, inside an
 * `ob-choice-grid`. A button, so its lines are spans: a heading inside it
 * would lose its role anyway. The purpose step's choices are their title
 * alone; the server step's say more under it.
 */
export function ChoiceCard({
  icon,
  title,
  body,
  action,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  body?: string
  action: string
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}>
      {icon}
      <strong className="ob-choice-title">{title}</strong>
      {body && <span className="ob-choice-body">{body}</span>}
      <span className="ob-choice-action">
        {action}
        <ArrowRight size={17} aria-hidden="true" />
      </span>
    </button>
  )
}
