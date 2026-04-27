ATOMIC-CHAT · CONCURRENT DEMO
================================================================================

Thanks for helping us record the video! Follow the three steps below
and you will see sixteen AI agents generating ASCII art of different
animals in parallel, each in its own Terminal window, tiled in a 4x4
grid.

--------------------------------------------------------------------------------
STEP 1 · Install & run Atomic-Chat
--------------------------------------------------------------------------------

  1. Download and install Atomic-Chat:
       https://atomic-chat.ai/download          (or the release URL we shared)

  2. Open the app. Sign in / skip onboarding.

--------------------------------------------------------------------------------
STEP 2 · Load the model and turn on Concurrent Mode
--------------------------------------------------------------------------------

  In Atomic-Chat:

  1. Settings (gear icon) → Providers → "Llama.cpp" (or "Llama.cpp + TurboQuant").

  2. Download / install the model:
       gemma-4-E4B-it-IQ4_XS

  3. In the same panel, scroll down to "Concurrent Mode" and toggle:
       [x] Concurrent Mode      ON
       Concurrent Slots:        16
       [x] Expose Prometheus /metrics  (auto-enabled with Concurrent Mode)

     Note: each slot splits the model context evenly, so 16 slots will give
     each agent roughly ctx_size / 16 tokens. For a good visual with ASCII
     art, set the global "Context Size" in the same panel to at least 32768
     (ideally 65536 if your RAM allows) so every slot gets ≥2048 tokens.
     If the model refuses to answer or replies get truncated, either reduce
     DEMO_TASKS (see below) or raise the context size.

  4. Start the model (click the power button next to the model name).
     You should see a green dot indicating it's running.

  5. Settings → Local API Server → make sure it is ON (default port: 1337).

--------------------------------------------------------------------------------
STEP 3 · Run the demo
--------------------------------------------------------------------------------

  macOS (recommended — one click):

      In Finder, double-click:   Start Demo.command

  ───  IMPORTANT: first-time macOS unlock  ──────────────────────────────
  If macOS says the file is "damaged and can't be opened" or shows a
  security warning, it's because the system marked the downloaded zip
  as quarantined. Fix it ONCE with the command below:

      1. Open Terminal (Cmd+Space → type "Terminal" → Enter).
      2. Paste the following, replacing the path with YOUR unzipped
         folder (drag it from Finder into Terminal to auto-fill):

             xattr -cr "/path/to/concurrent-demo-<version>"

         Example:
             xattr -cr ~/Desktop/concurrent-demo-20260422

      3. Now double-click "Start Demo.command" — it will work.

  Alternative: System Settings → Privacy & Security → scroll down →
  click "Open Anyway" for Start Demo.command, then double-click again.
  ──────────────────────────────────────────────────────────────────────

  Manual / command line (always works, no unlock needed):

      cd ~/Desktop/concurrent-demo-<version>
      bash "Start Demo.command"

  What happens:
    • The script verifies that Atomic-Chat is running and the model is loaded.
    • A wide DASHBOARD window opens at the top of the screen, showing
      combined throughput (t/s), total tokens, and a compact status grid
      for every agent.
    • Sixteen new Terminal windows open below the dashboard, tiled in a
      4x4 grid. Each window streams one AI agent generating a piece of
      ASCII art.
    • When every agent finishes, a web page with the gallery opens
      automatically in your browser.

  Tip: if your display is small or the grid looks cramped for filming,
  reduce the number of agents before recording:

      DEMO_TASKS=9  ./Start\ Demo.command    # 3x3 grid
      DEMO_TASKS=4  ./Start\ Demo.command    # 2x2 grid (easiest to film)

--------------------------------------------------------------------------------
CUSTOMIZING FOR THE VIDEO
--------------------------------------------------------------------------------

You can tweak the demo by setting environment variables before launching.
For example, to generate 6 agents about "space exploration":

  DEMO_TOPIC="space exploration" DEMO_TASKS=6 ./Start\ Demo.command

Available variables (with defaults):

  DEMO_SCENARIO   ascii       Scenario: ascii | svg | translate | code
  DEMO_TOPIC      animals     Free-form topic; orchestrator splits it into
                              one specific subject per agent (e.g. cat, dog,
                              owl, octopus…). Try "fruits", "vehicles",
                              "space", "mythological creatures" etc.
  DEMO_TASKS      16          Number of concurrent agents (and windows)
  ATOMIC_MODEL    gemma-4-E4B-it-IQ4_XS
  ATOMIC_BASE_URL http://127.0.0.1:1337/v1
  ATOMIC_API_KEY  (empty)     Only needed if you set one in Local API Server

Note: DEMO_TASKS should match the "Concurrent Slots" setting in Atomic-Chat.
If they differ, llama.cpp will simply queue the extra requests — but the
visual effect is strongest when every agent gets its own slot.

--------------------------------------------------------------------------------
TROUBLESHOOTING
--------------------------------------------------------------------------------

  ✗ '"Start Demo.command" is damaged and can't be opened'
    or 'cannot verify the developer'
      → macOS quarantine. Open Terminal and run ONCE:
            xattr -cr ~/Desktop/concurrent-demo-<version>
        Then double-click the file again.
      → Or: System Settings → Privacy & Security → "Open Anyway".

  ✗ "Atomic-Chat local API server is not reachable"
      → Open Atomic-Chat; Settings → Local API Server → toggle ON.

  ✗ "Model did not respond"
      → The model isn't loaded. In Atomic-Chat, click the power button
        next to gemma-4-E4B-it-IQ4_XS.

  ✗ A Terminal window shows a "metrics endpoint not supported" error
      → Enable "Concurrent Mode" in Atomic-Chat settings and restart
        the model. (This turns on llama.cpp's --metrics flag.)

  ✗ "uv is not installed"
      → The launcher will auto-install it for you. If that fails,
        run: curl -LsSf https://astral.sh/uv/install.sh | sh
        then launch the demo again.

--------------------------------------------------------------------------------

Happy recording!
