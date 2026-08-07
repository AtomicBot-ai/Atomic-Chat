import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

type SearchParams = {
  repo?: string
  q?: string
}

/**
 * Legacy per-model page, kept as a redirect.
 *
 * Model details now live in the right-hand panel of `/hub/`, addressed by
 * `?model=owner/repo`. Deep links published in earlier releases — including
 * the `atomic-chat://` handler in `DataProvider` — still point here, so this
 * route forwards them instead of 404ing.
 */
export const Route = createFileRoute('/hub/$modelId')({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    repo: typeof search.repo === 'string' ? search.repo : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: route.hub.index,
      search: {
        model: params.modelId,
        ...(search.repo ? { repo: search.repo } : {}),
        ...(search.q ? { q: search.q } : {}),
      },
      replace: true,
    })
  },
})
