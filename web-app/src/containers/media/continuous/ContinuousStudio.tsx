/**
 * Continuous: chain video clips into a longer movie, plan the shots from one
 * story with the local chat model, and schedule sessions or single jobs.
 *
 * Progressive settings: the essentials (story, segments, length, runs, prompt,
 * start source, schedule time) are always visible; everything else sits in
 * collapsed "Advanced" sections. Work runs in a module-scoped store, so the
 * rest of the app stays usable and a session survives leaving this page.
 */
import { useEffect, useMemo, useState } from 'react'
import { ulid } from 'ulidx'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useContinuousSessions } from '@/stores/continuous-session-store'
import {
  effectivePrompts,
  expandSteps,
  segmentProgress,
  validateSegments,
  type ContinuousSegment,
  type ContinuousSession,
} from '@/services/media/continuous/session'
import {
  parsePlanMarkdown,
  planTimeline,
  planToMarkdown,
} from '@/services/media/continuous/planner'
import { defaultPlannerDeps } from '@/services/media/continuous/chatPlanner'
import type { ScheduleRepeat } from '@/services/media/continuous/schedule'

const DEFAULT_CLIP_SECONDS = 5

function newSegment(prompt = ''): ContinuousSegment {
  return { id: ulid(), prompt, start: { kind: 'previous' }, runs: 1, length_seconds: DEFAULT_CLIP_SECONDS }
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const label = 'text-xs font-medium text-muted-foreground'
const section = 'rounded-lg border border-border/60 bg-background p-3 space-y-3'

function SegmentEditor({
  segment,
  index,
  inherited,
  onChange,
  onRemove,
}: {
  segment: ContinuousSegment
  index: number
  inherited: string
  onChange: (next: ContinuousSegment) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-md border border-border/60 p-2 space-y-2" data-testid="continuous-segment">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Segment {index + 1}</span>
        <Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
      </div>
      <Textarea
        value={segment.prompt}
        placeholder={inherited ? `Inherits: ${inherited}` : 'Describe this shot'}
        onChange={(e) => onChange({ ...segment, prompt: e.target.value })}
        rows={2}
      />
      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1">
          <span className={label}>Start from</span>
          <select
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            value={segment.start.kind}
            onChange={(e) => {
              const kind = e.target.value as 'previous' | 'image' | 'none'
              onChange({ ...segment, start: kind === 'image' ? { kind, image: '' } : { kind } })
            }}
          >
            <option value="previous">Last frame of previous clip</option>
            <option value="image">Chosen image</option>
            <option value="none">Text only</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className={label}>Runs</span>
          <Input type="number" min={1} max={100} value={segment.runs}
            onChange={(e) => onChange({ ...segment, runs: Number(e.target.value) || 1 })} />
        </label>
        <label className="space-y-1">
          <span className={label}>Clip length (s)</span>
          <Input type="number" min={1} value={segment.length_seconds ?? ''}
            onChange={(e) => onChange({ ...segment, length_seconds: e.target.value ? Number(e.target.value) : undefined })} />
        </label>
      </div>
      {segment.start.kind === 'image' && (
        <input type="file" accept="image/*" className="text-xs"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (file) onChange({ ...segment, start: { kind: 'image', image: await readImage(file), name: file.name } })
          }} />
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Advanced</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className={label}>FPS</span>
            <Input type="number" min={1} value={segment.fps ?? ''}
              onChange={(e) => onChange({ ...segment, fps: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
          <label className="space-y-1">
            <span className={label}>Seed</span>
            <Input type="number" value={(segment.params?.seed as number | undefined) ?? ''}
              onChange={(e) => {
                const params = { ...(segment.params ?? {}) }
                if (e.target.value) params.seed = Number(e.target.value)
                else delete params.seed
                onChange({ ...segment, params })
              }} />
          </label>
        </div>
      </details>
    </div>
  )
}

function ScheduleControls({ onSchedule }: { onSchedule: (at: number, repeat: ScheduleRepeat) => void }) {
  const [when, setWhen] = useState('')
  const [repeat, setRepeat] = useState<ScheduleRepeat>('none')
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className={label}>Start at</span>
        <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label className="space-y-1">
        <span className={label}>Repeat</span>
        <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={repeat}
          onChange={(e) => setRepeat(e.target.value as ScheduleRepeat)}>
          <option value="none">Once</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      <Button variant="outline" size="sm" disabled={!when}
        onClick={() => onSchedule(new Date(when).getTime(), repeat)}>Schedule</Button>
    </div>
  )
}

export function ContinuousStudio() {
  const store = useContinuousSessions()
  const [name, setName] = useState('Untitled movie')
  const [story, setStory] = useState('')
  const [segmentCount, setSegmentCount] = useState(4)
  const [segmentSeconds, setSegmentSeconds] = useState(10)
  const [clipSeconds, setClipSeconds] = useState(DEFAULT_CLIP_SECONDS)
  const [planMd, setPlanMd] = useState('')
  const [planning, setPlanning] = useState(false)
  const [segments, setSegments] = useState<ContinuousSegment[]>([newSegment()])
  const [stitch, setStitch] = useState(true)
  const [negative, setNegative] = useState('')
  const [jobPrompt, setJobPrompt] = useState('')
  const [jobTask, setJobTask] = useState<'text_to_image' | 'text_to_video'>('text_to_video')

  useEffect(() => {
    void store.load().catch((e) => console.warn('[continuous] load failed', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const inherited = useMemo(() => effectivePrompts(segments), [segments])
  const problems = validateSegments(segments)
  const totalRuns = segments.reduce((n, s) => n + Math.max(1, s.runs), 0)

  const runsPerSegment = Math.max(1, Math.ceil(segmentSeconds / Math.max(1, clipSeconds)))

  const applyPlan = (markdown: string) => {
    const parsed = parsePlanMarkdown(markdown)
    if (parsed.length === 0) {
      toast.error('No "## Segment" sections found in the plan.')
      return
    }
    setSegments(parsed.map((p) => ({ ...newSegment(p.prompt), runs: runsPerSegment, length_seconds: clipSeconds })))
  }

  const plan = async () => {
    setPlanning(true)
    try {
      const result = await planTimeline(
        { story, segments: segmentCount, length_seconds: segmentSeconds },
        await defaultPlannerDeps()
      )
      const md = planToMarkdown(result)
      setPlanMd(md)
      applyPlan(md)
      toast.success(result.source === 'model' ? 'Timeline planned by your chat model.' : 'No chat model answered; used the built-in splitter.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPlanning(false)
    }
  }

  const buildSession = (): ContinuousSession => {
    const now = Date.now()
    return {
      id: ulid(),
      name: name.trim() || 'Untitled movie',
      created_at: now,
      updated_at: now,
      ...(story.trim() ? { story: story.trim() } : {}),
      segments,
      steps: expandSteps(segments),
      status: 'draft',
      stitch,
      ...(negative.trim() ? { base_params: { negative_prompt: negative.trim() } } : {}),
    }
  }

  const planFor = () =>
    planMd ||
    planToMarkdown({ story: story || name, segments: segments.map((_, i) => ({ index: i, prompt: inherited[i] ?? '' })) })

  const save = async (then?: (session: ContinuousSession) => Promise<void>) => {
    if (problems.length > 0) {
      toast.error(problems[0])
      return
    }
    const session = buildSession()
    await store.saveSession(session, planFor())
    if (then) await then(session)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <div className="space-y-4">
        <div className={section}>
          <h3 className="text-sm font-semibold">Timeline planner</h3>
          <Textarea value={story} rows={3} placeholder='Overall story, e.g. "a man walks down the street and walks into a doorway to his house"'
            onChange={(e) => setStory(e.target.value)} />
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1"><span className={label}>Segments</span>
              <Input type="number" min={1} max={50} value={segmentCount} onChange={(e) => setSegmentCount(Number(e.target.value) || 1)} /></label>
            <label className="space-y-1"><span className={label}>Seconds per segment</span>
              <Input type="number" min={1} value={segmentSeconds} onChange={(e) => setSegmentSeconds(Number(e.target.value) || 1)} /></label>
            <label className="space-y-1"><span className={label}>Clip length (s)</span>
              <Input type="number" min={1} value={clipSeconds} onChange={(e) => setClipSeconds(Number(e.target.value) || 1)} /></label>
          </div>
          <p className="text-xs text-muted-foreground">
            Each segment becomes {runsPerSegment} chained run(s) of {clipSeconds}s.
          </p>
          <Button size="sm" disabled={!story.trim() || planning} onClick={() => void plan()}>
            {planning ? 'Planning…' : 'Plan timeline'}
          </Button>
          {planMd && (
            <details open>
              <summary className="cursor-pointer text-xs text-muted-foreground">Plan (markdown, editable)</summary>
              <Textarea className="mt-2 font-mono text-xs" rows={10} value={planMd} onChange={(e) => setPlanMd(e.target.value)} />
              <Button className="mt-2" variant="outline" size="sm" onClick={() => applyPlan(planMd)}>Apply edits to segments</Button>
            </details>
          )}
        </div>

        <div className={section}>
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Session name" />
            <span className="whitespace-nowrap text-xs text-muted-foreground">{totalRuns} run(s)</span>
          </div>
          {segments.map((segment, index) => (
            <SegmentEditor key={segment.id} segment={segment} index={index}
              inherited={index > 0 ? (inherited[index - 1] ?? '') : ''}
              onChange={(next) => setSegments(segments.map((s) => (s.id === next.id ? next : s)))}
              onRemove={() => setSegments(segments.filter((s) => s.id !== segment.id))} />
          ))}
          <Button variant="outline" size="sm" onClick={() => setSegments([...segments, newSegment()])}>Add segment</Button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={stitch} onChange={(e) => setStitch(e.target.checked)} />
            Stitch into one video at the end (keeps the clips too; needs ffmpeg)
          </label>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Advanced</summary>
            <label className="mt-2 block space-y-1"><span className={label}>Negative prompt (all runs)</span>
              <Input value={negative} onChange={(e) => setNegative(e.target.value)} /></label>
            <p className="mt-1 text-xs text-muted-foreground">Model, resolution and other settings come from your last Media generation.</p>
          </details>
          {problems.length > 0 && <p className="text-xs text-destructive">{problems[0]}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" disabled={problems.length > 0} onClick={() => void save((s) => store.start(s.id))}>Start now</Button>
            <Button variant="outline" size="sm" disabled={problems.length > 0} onClick={() => void save(async () => { toast.success('Session saved.') })}>Save</Button>
            <ScheduleControls onSchedule={(at, repeat) => void save(async (s) => {
              await store.addSchedule({ label: s.name, target: { kind: 'session', session_id: s.id }, at, repeat, enabled: true })
              toast.success('Session scheduled.')
            })} />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className={section}>
          <h3 className="text-sm font-semibold">Sessions</h3>
          {store.sessions.length === 0 && <p className="text-xs text-muted-foreground">No sessions yet.</p>}
          {store.sessions.map((session) => (
            <div key={session.id} className="space-y-1 rounded-md border border-border/60 p-2" data-testid="continuous-session">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{session.name}</span>
                <span className="text-xs text-muted-foreground">{session.status}</span>
              </div>
              <ul className="space-y-0.5">
                {segmentProgress(session).map((p) => (
                  <li key={p.segment} className="flex justify-between text-xs">
                    <span>Segment {p.segment + 1}</span>
                    <span>{p.done}/{p.total} · {p.status}</span>
                  </li>
                ))}
              </ul>
              {session.error && <p className="text-xs text-muted-foreground">{session.error}</p>}
              {session.stitched_path && <p className="break-all text-xs">Stitched: {session.stitched_path}</p>}
              <div className="flex gap-1">
                {(session.status === 'running' || session.status === 'scheduled') ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => store.pause(session.id)}>Pause</Button>
                    <Button variant="outline" size="sm" onClick={() => store.cancel(session.id)}>Cancel</Button>
                  </>
                ) : (
                  session.status !== 'succeeded' && (
                    <Button variant="outline" size="sm" onClick={() => void store.start(session.id)}>
                      {session.status === 'draft' ? 'Start' : 'Resume'}
                    </Button>
                  )
                )}
                <Button variant="ghost" size="sm" onClick={() => void store.removeSession(session.id)}>Forget</Button>
              </div>
            </div>
          ))}
        </div>

        <div className={section}>
          <h3 className="text-sm font-semibold">Schedules</h3>
          <p className="text-xs text-muted-foreground">Schedules run only while Radium is open; a missed one runs at next launch.</p>
          {store.schedules.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{s.label} · {new Date(s.at).toLocaleString()} · {s.repeat}{s.enabled ? '' : ' (done)'}</span>
              <Button variant="ghost" size="sm" onClick={() => void store.removeSchedule(s.id)}>Remove</Button>
            </div>
          ))}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Schedule a single job</summary>
            <div className="mt-2 space-y-2">
              <select className="rounded-md border bg-background px-2 py-1 text-sm" value={jobTask}
                onChange={(e) => setJobTask(e.target.value as typeof jobTask)}>
                <option value="text_to_video">Video</option>
                <option value="text_to_image">Image</option>
              </select>
              <Textarea rows={2} value={jobPrompt} placeholder="Prompt" onChange={(e) => setJobPrompt(e.target.value)} />
              <ScheduleControls onSchedule={(at, repeat) => {
                if (!jobPrompt.trim()) return void toast.error('Write a prompt first.')
                void store.addSchedule({ label: jobPrompt.slice(0, 40), target: { kind: 'job', task: jobTask, prompt: jobPrompt.trim() }, at, repeat, enabled: true })
              }} />
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
