import { useState } from 'react'
import { Flag, RotateCcw } from 'lucide-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  MINES_CELLS,
  MINES_COUNT,
  MINES_SIZE,
  countAround,
  isCleared,
  placeMines,
  revealCells,
} from '@/lib/onboarding/mines'
import { cn } from '@/lib/utils'

/**
 * Atomic Mines: a minesweeper to pass the time on the wait screen
 * (`WaitStep`). Right-click or flag mode marks an atom; the first move is
 * always safe (`lib/onboarding/mines`). Nothing of a game is kept.
 */
export function AtomicMines() {
  const { t } = useTranslation()
  const [mines, setMines] = useState<number[] | null>(null)
  const [opened, setOpened] = useState<number[]>([])
  const [flags, setFlags] = useState<number[]>([])
  const [lost, setLost] = useState(false)
  const [flagMode, setFlagMode] = useState(false)
  const won = isCleared(opened)
  const over = lost || won

  const flag = (cell: number) => {
    if (over || opened.includes(cell)) return
    setFlags((current) =>
      current.includes(cell)
        ? current.filter((n) => n !== cell)
        : current.length < MINES_COUNT
          ? [...current, cell]
          : current
    )
  }

  const reveal = (cell: number) => {
    if (over || flags.includes(cell)) return
    const placed = mines ?? placeMines(cell)
    setMines(placed)
    if (placed.includes(cell)) {
      setLost(true)
      return
    }
    setOpened((current) => revealCells(cell, placed, flags, current))
  }

  const reset = () => {
    setMines(null)
    setOpened([])
    setFlags([])
    setLost(false)
  }

  const cellLabel = (cell: number, open: boolean, count: number) => {
    const place = {
      row: Math.floor(cell / MINES_SIZE) + 1,
      column: (cell % MINES_SIZE) + 1,
    }
    if (open) return t('onboarding-wait:mines.cellOpen', { ...place, count })
    if (flags.includes(cell)) {
      return t('onboarding-wait:mines.cellFlagged', place)
    }
    return t('onboarding-wait:mines.cellHidden', place)
  }

  return (
    <section className="ob-game" aria-label={t('onboarding-wait:mines.title')}>
      <div className="ob-game-heading">
        <div>
          <h3>{t('onboarding-wait:mines.title')}</h3>
          <span>
            {t('onboarding-wait:mines.unmarked', {
              count: MINES_COUNT - flags.length,
            })}
          </span>
        </div>
        <button
          type="button"
          className="ob-icon"
          aria-label={t('onboarding-wait:mines.newGame')}
          onClick={reset}
        >
          <RotateCcw size={18} aria-hidden="true" />
        </button>
      </div>
      <div
        className="ob-mine-grid"
        role="group"
        aria-label={t('onboarding-wait:mines.board')}
      >
        {Array.from({ length: MINES_CELLS }, (_, cell) => {
          const open = opened.includes(cell)
          const atom = lost && mines?.includes(cell)
          const count = mines ? countAround(cell, mines) : 0
          return (
            <button
              key={cell}
              type="button"
              className={cn(open && 'revealed', atom && 'mine')}
              data-count={open ? count : undefined}
              aria-label={cellLabel(cell, open, count)}
              disabled={over || open}
              onClick={() => (flagMode ? flag(cell) : reveal(cell))}
              onContextMenu={(event) => {
                event.preventDefault()
                flag(cell)
              }}
            >
              {atom ? (
                <img
                  src="/images/transparent-logo.png"
                  alt=""
                  draggable={false}
                />
              ) : flags.includes(cell) ? (
                <Flag aria-hidden="true" />
              ) : open && count > 0 ? (
                count
              ) : null}
            </button>
          )
        })}
      </div>
      <div className="ob-game-tools">
        <button
          type="button"
          className="ob-secondary"
          aria-pressed={flagMode}
          onClick={() => setFlagMode((on) => !on)}
        >
          <Flag aria-hidden="true" />
          {flagMode
            ? t('onboarding-wait:mines.flagModeOn')
            : t('onboarding-wait:mines.flagMode')}
        </button>
        <span role="status">
          {lost
            ? t('onboarding-wait:mines.lost')
            : won
              ? t('onboarding-wait:mines.won')
              : t('onboarding-wait:mines.goal')}
        </span>
      </div>
      <p>{t('onboarding-wait:mines.help')}</p>
    </section>
  )
}
