import { page } from '@vitest/browser/context'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, it, expect } from 'vitest'
import i18n from '@/i18n/setup'
import { DEFAULT_FONT_SIZE, XL_FONT_SIZE, expectNoHorizontalOverflow, settle, setFontSize, setTheme, withTranslations } from '@/test/layout'
import { CancelDownloadDialog } from './CancelDownloadDialog'

for (const language of ['en', 'ko']) for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) for (const viewport of [1024, 1280]) for (const theme of ['light', 'dark'] as const) {
  describe(`cancel confirmation ${language} ${font} ${viewport} ${theme}`, () => {
    afterEach(async () => { await i18n.changeLanguage('en') })
    it('keeps long names, error text and all three actions inside the dialog', async () => {
      await page.viewport(viewport, 800)
      await i18n.changeLanguage(language)
      setFontSize(font)
      setTheme(theme)
      render(withTranslations(<div style={{ width: viewport }}><CancelDownloadDialog
        name="AtomicChat/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64"
        busy={false} error="Permission denied while deleting /Volumes/External/AtomicChat/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64/very-long-shard-name.gguf.tmp" canDeleteFiles onBack={() => {}} onKeep={() => {}} onDeleteFiles={() => {}}
      /></div>))
      await act(async () => { await settle() })
      expect(screen.getByRole('alert')).toHaveTextContent('Permission denied while deleting')
      const dialog = screen.getByRole('dialog')
      expectNoHorizontalOverflow(dialog)
      for (const button of dialog.querySelectorAll('button')) {
        expectNoHorizontalOverflow(button)
        const bounds = button.getBoundingClientRect()
        expect(bounds.right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right)
      }
    })
  })
}
