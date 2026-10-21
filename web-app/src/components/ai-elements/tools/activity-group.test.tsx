import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n/setup'
import { TranslationContext } from '@/i18n/context'
import { ToolActivityGroup } from './activity-group'

type Tools = Parameters<typeof ToolActivityGroup>[0]['tools']

const completedTools = (count: number): Tools =>
  Array.from({ length: count }, (_, index) => ({
    key: `tool-${index}`,
    toolName: 'os.shell.run',
    state: 'output-available',
    presentation: { kind: 'generic', title: 'os.shell.run' },
  }))

const renderGroup = (count: number) =>
  render(
    <TranslationContext.Provider
      value={{ t: (key, options) => i18n.t(key, options), i18n }}
    >
      <ToolActivityGroup tools={completedTools(count)} />
    </TranslationContext.Provider>
  )

const completed = (language: string, count: number) => {
  i18n.language = language
  return i18n.t('chat:activity.completedActions', { count })
}

describe('ToolActivityGroup completed headline', () => {
  const original = i18n.language

  afterEach(() => {
    i18n.language = original
  })

  it('uses the singular for one action and the plural otherwise', () => {
    i18n.language = 'en'

    renderGroup(1)
    expect(screen.getByRole('button')).toHaveTextContent('Completed 1 action')
    expect(screen.getByRole('button')).not.toHaveTextContent('actions')
  })

  it('keeps the plural for several actions', () => {
    i18n.language = 'en'

    renderGroup(3)
    expect(screen.getByRole('button')).toHaveTextContent('Completed 3 actions')
  })

  it('follows each language plural rules', () => {
    expect(completed('ru', 1)).toBe('Выполнено 1 действие')
    expect(completed('ru', 3)).toBe('Выполнено 3 действия')
    expect(completed('ru', 5)).toBe('Выполнено 5 действий')
    expect(completed('ru', 21)).toBe('Выполнено 21 действие')
    expect(completed('pl', 1)).toBe('Ukończono 1 działanie')
    expect(completed('pl', 4)).toBe('Ukończono 4 działania')
    expect(completed('pl', 12)).toBe('Ukończono 12 działań')
    expect(completed('cs', 1)).toBe('Dokončena 1 akce')
    expect(completed('cs', 2)).toBe('Dokončeny 2 akce')
    expect(completed('cs', 7)).toBe('Dokončeno 7 akcí')
    expect(completed('de-DE', 1)).toBe('1 Aktion abgeschlossen')
    expect(completed('de-DE', 2)).toBe('2 Aktionen abgeschlossen')
    expect(completed('fr', 1)).toBe('1 action terminée')
    expect(completed('es', 2)).toBe('2 acciones completadas')
    expect(completed('pt-BR', 1)).toBe('1 ação concluída')
  })

  it('has its own translation in every language', () => {
    const english = new Set([1, 2, 5].map((count) => completed('en', count)))
    for (const language of Object.keys(i18n.resources)) {
      if (language === 'en') continue
      for (const count of [1, 2, 5]) {
        const text = completed(language, count)
        expect(text, `${language} / ${count}`).toContain(String(count))
        expect(english.has(text), `${language} / ${count}`).toBe(false)
      }
    }
  })
})
