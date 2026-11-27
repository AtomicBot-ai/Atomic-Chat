import { ExternalLink } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function HuggingFaceRepoLink({
  repo,
  label,
}: {
  repo: string
  label?: string
}) {
  const { t } = useTranslation()
  return (
    <a
      href={`https://huggingface.co/${repo}`}
      title={repo}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs hover:bg-secondary"
    >
      <img
        src="/images/model-provider/huggingface.svg"
        alt=""
        className="size-4"
      />
      {label ?? t('hub:source.huggingFace')}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  )
}
