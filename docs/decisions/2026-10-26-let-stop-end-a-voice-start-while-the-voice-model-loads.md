---
date: 2026-10-26
title: "Let Stop end a voice start while the voice model is still loading"
---

# 2026-10-26 — Let Stop end a voice start while the voice model is still loading

- **Context:** QA of 2.2.25 (NEW-07, MacBook Air M3, 8 GB) pressed the
  microphone, saw "Starting the voice model…", and pressed Stop and insert
  straight away. The core took 85 s to bring Voxtral up (core log 14:52:00 →
  14:53:28 UTC). When the tester could use the app again, the recording timer
  read 5:51, and only Discard ended the recording. The code explains this:
  - The microphone opens only after `ensureVoiceEngine` resolves, so during
    `starting` there is no native session and nothing is being recorded.
  - While starting, the toolbar button showed a spinner but was labelled "Stop
    and insert". `VoiceInputToggle` dropped clicks in every pending phase, and
    `stop()` returned early because there was no session id.
  - `begin()` never checked, after its awaits, whether anyone was still
    waiting. Once the model came up it opened the microphone and set
    `listening` anyway. That happened after a Discard too, and then the
    session had no owner: no composer showed the strip, and none could stop
    it. A composer closed during the start left the same orphan, because its
    unmount cleanup only cancelled when a session id existed.
  - The composer placeholder said "Listening — start speaking" during the
    start, so anything said then was lost.
  - The voice server's 5-minute idle unload (it resets only on a transcript)
    then stopped the server under the still-open recording (core log
    14:58:39).

- **Decision:** The microphone still opens only once the voice model is up.
  While the model loads, the toolbar button is the Stop control: a stop square
  labelled "Stop voice input". Pressing it, or Enter, ends the start at once.
  Nothing has been captured, so nothing is transcribed, and the composer shows
  "Voice input stopped before the voice model was ready. Nothing was
  recorded." Discard and closing the composer end a start the same way,
  without that notice. `begin()` keeps a start-attempt counter that Stop,
  Discard and `reset()` bump. It checks the counter after every await, and if
  the microphone opened in the same instant as a Stop, it cancels that
  session. During the start the placeholder reads "Starting the voice model —
  speak once it's listening".

- **Consequences:**
  - A Stop can no longer be ignored, and a start cannot turn into a recording
    nobody asked for or can see. Recording only ever begins for a composer
    that is still waiting for it.
  - Stopping does not cancel the model load. The load finishes and the usual
    5-minute idle unload frees the model, so pressing the microphone again
    soon after starts at once.
  - Speech during the load is still not captured. This is the same as before;
    the difference is that the UI now says so. Capturing from the first press
    and transcribing once the model is ready was not done here. It needs a
    deferred-target mode in `tauri-plugin-atomic-audio`: the consumer would
    wait for `set_transcription_target`, and the worker's bounded
    `blocking_send` must not block `stop_dictation` meanwhile. It also needs a
    bounded wait after Stop with a visible "still loading" state. That is the
    natural follow-up.
  - Not changed: a live session with no transcript for 5 minutes still lets
    the voice server unload under it, and a recording has no length or
    silence limit. Both remain open.
  - The recording strip still shows its pulsing record dot during the start.

- **Owner:** `team`.
- **Links:**
  - `web-app/src/hooks/useVoiceInput.ts` — `startAttempt`, `begin`, `stop`, `cancel`
  - `web-app/src/containers/VoiceInputToggle.tsx`, `web-app/src/containers/ChatInput.tsx`
  - [2026-08-24 — Dictate into the composer with a local Voxtral model](2026-08-24-dictate-into-the-composer-with-a-local-voxtral-model.md)
