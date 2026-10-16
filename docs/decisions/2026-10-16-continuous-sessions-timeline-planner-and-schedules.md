# Continuous sessions, timeline planner and schedules

**Date:** 2026-10-16 · **Status:** accepted

## Decision

- A *continuous session* is an ordered list of segments; each expands into `runs`
  consecutive steps (`services/media/continuous/session.ts`). Steps run one at a
  time through the shared media job manager, with no user interaction between them.
- Each step's `init_image` is the last frame of the previous finished clip,
  extracted with the existing browser `videoFrames.ts` path (no new dependency),
  or a user-chosen image for the first run of a segment. A blank prompt inherits
  the previous segment's effective prompt.
- Finished clips are materialised into the Library as each run completes, so
  pause / cancel / failure / crash never lose them. A session that was running at
  shutdown loads as `paused` and resumes from the first unfinished step.
- Stitching uses the **system** `ffmpeg` on PATH (`media_stitch_videos`; concat
  demuxer with stream copy, falling back to an H.264 re-encode). Radium does not
  bundle ffmpeg; without it the clips stay separate and the session says so.
- The *timeline planner* asks the user's selected chat model (via `ModelFactory`,
  i.e. the normal llama.cpp session path) for a `## Segment N` markdown timeline,
  and falls back to a deterministic splitter when no model is selected/answers.
  The plan is stored as `plan.md` next to `session.json` under
  `<data_folder>/media/continuous/sessions/<id>/`.
- *Schedules* persist in `<data_folder>/media/continuous/schedules.json` and are
  checked every 30 s **only while the app is open**. A missed schedule fires once
  on next launch; repeats then move to their next future time.
- Resolution is not touched: requests are built by `resolveChatRequest`, the same
  resolver chat uses, and only prompt/length/fps/init_image/seed are overlaid.
