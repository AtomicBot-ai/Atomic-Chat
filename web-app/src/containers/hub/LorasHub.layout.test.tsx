import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n/setup'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import {
  loras,
  useLoraInventoryVersion,
  type Lora,
  type LoraMode,
} from '@/services/loras'
import { LoraPicker } from '../LoraPicker'
import { LorasHub } from './LorasHub'
import { route } from '@/constants/routes'
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}))
const row: Lora = {
  sha256: 'a'.repeat(64),
  mode: 'image',
  repo: 'publisher/' + 'long-model-name-'.repeat(8),
  target: 'model/testing',
  file: 'long-weight-file-name-'.repeat(6) + 'adapter.safetensors',
  size: 161287952,
}
afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('en')
})
it.each([
  ['en', 'light', 'chat'],
  ['ru', 'dark', 'image'],
  ['en', 'dark', 'video'],
] as const)(
  'installs and selects a patch in the narrow %s sidebar (%s, %s)',
  async (language, theme, mode: LoraMode) => {
    await i18n.changeLanguage(language)
    setFontSize(XL_FONT_SIZE)
    setTheme(theme)
    await page.viewport(1024, 800)
    let installed = false
    let adapterId: string | null = null
    const refresh = () =>
      useLoraInventoryVersion.setState((s) => ({ version: s.version + 1 }))
    vi.spyOn(loras, 'list').mockImplementation(async () => ({
      files: installed ? [row] : [],
      downloads: [],
    }))
    vi.spyOn(loras, 'search').mockResolvedValue({
      results: [row],
      partial: false,
    })
    vi.spyOn(loras, 'choices').mockImplementation(async () => ({
      target: row.target,
      adapterId,
      files: installed ? [row] : [],
    }))
    vi.spyOn(loras, 'install').mockImplementation(async () => {
      installed = true
      refresh()
    })
    vi.spyOn(loras, 'select').mockImplementation(async (_mode, _model, id) => {
      adapterId = id
    })
    function Panel() {
      const [target, setTarget] = useState<string>()
      navigate.mockImplementation(({ search }) => setTarget(search.target))
      return (
        <div style={{ width: 320 }}>
          <LoraPicker mode={mode} model="model:q4" />
          <LorasHub target={target} onClear={() => setTarget(undefined)} />
        </div>
      )
    }
    const view = render(withTranslations(<Panel />))
    const select = screen.getByRole('combobox', {
      name: 'LoRA',
    }) as HTMLSelectElement
    await screen.findByRole('option', { name: i18n.t('hub:loras.none') })
    expect(select.disabled).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('hub:loras.find') })
    )
    expect(navigate).toHaveBeenCalledWith({
      to: route.hub.index,
      search: { category: 'loras', target: row.target },
    })
    const link = await screen.findByRole('link', { name: 'Hugging Face' })
    expect(link.getAttribute('href')).toBe(`https://huggingface.co/${row.repo}`)
    expect(link.getAttribute('target')).toBe('_blank')
    fireEvent.click(
      await screen.findByRole('button', {
        name: i18n.t('hub:drafters.download'),
      })
    )
    await waitFor(() => expect(select.disabled).toBe(false))
    fireEvent.change(select, { target: { value: row.sha256 } })
    await waitFor(() => expect(select.value).toBe(row.sha256))
    expect(adapterId).toBe(row.sha256)
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(adapterId).toBeNull())
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('hub:drafters.clear') })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: i18n.t('hub:drafters.clear') })
      ).toBeNull()
    )
    await settle()
    expectNoHorizontalOverflow(view.container.firstElementChild as HTMLElement)
    view.unmount()
  }
)
