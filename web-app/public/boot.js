/*
 * Radium boot screen.
 *
 * A classic script, loaded by index.html before the app bundle, with no
 * imports of its own. It has to keep working when the bundle does not: a
 * chunk that throws while it evaluates, an extension that never finishes
 * loading, a provider that never renders. Before this the startup screen was
 * removed on a 200 ms timer whether or not the app had drawn anything, so any
 * of those left a black window with no title bar to move or close it.
 *
 * What it does:
 *   - shows the logo and one line of status that the app updates as it starts
 *     (`window.__radiumBoot.step(id, label)`);
 *   - stays up until the app says it has drawn (`window.__radiumBoot.ready()`);
 *   - writes every step, its timing and any early error to app.log, plus a
 *     heartbeat while startup is unfinished, so a stuck start shows up there;
 *   - when nothing moves for STALL_MS, or an error is followed by no progress,
 *     turns into a panel that says where startup stopped and offers Keep
 *     waiting, Restart Radium, Open the log, and Quit;
 *   - on Windows, where the window has no native title bar, draws its own drag
 *     strip with Minimize and Close, so a stuck start can always be closed.
 *
 * See docs/decisions/2026-10-15-boot-screen-stays-until-the-app-has-drawn.md.
 */
;(function () {
  'use strict'

  var STALL_MS = 20000
  var AFTER_ERROR_MS = 8000
  var HEARTBEAT_MS = 5000
  var FADE_MS = 300
  var MAX_ERRORS = 5

  // tauri-plugin-log levels.
  var INFO = 3
  var WARN = 4
  var ERROR = 5

  var startedAt = Date.now()
  var loader = document.getElementById('initial-loader')
  if (!loader) return

  var statusEl = document.getElementById('boot-status')
  var problemEl = document.getElementById('boot-problem')
  var problemTitleEl = document.getElementById('boot-problem-title')
  var problemDetailEl = document.getElementById('boot-problem-detail')
  var problemErrorsEl = document.getElementById('boot-problem-errors')
  var keepWaitingButton = loader.querySelector('[data-boot-action="wait"]')

  var state = {
    id: 'page',
    label: statusEl ? statusEl.textContent : '',
    stepAt: startedAt,
    // Counts steps, so "has anything moved since?" does not depend on the
    // clock having ticked between two calls.
    seq: 0,
    ready: false,
    problem: null,
    errors: [],
  }
  var stallTimer = null
  var errorTimer = null
  var heartbeat = null

  function internals() {
    var value = window.__TAURI_INTERNALS__
    return value && typeof value.invoke === 'function' ? value : null
  }

  function invoke(command, args) {
    var tauri = internals()
    if (!tauri) return Promise.resolve(undefined)
    try {
      return Promise.resolve(tauri.invoke(command, args || {}))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function log(level, message) {
    invoke('plugin:log|log', {
      level: level,
      message: '[boot] ' + message,
    }).catch(function () {})
  }

  function elapsed() {
    return Date.now() - startedAt
  }

  function describe(value) {
    if (!value) return 'Unknown error'
    if (typeof value === 'string') return value
    if (value instanceof Error) {
      return value.name + ': ' + value.message
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  function windowLabel() {
    var tauri = internals()
    try {
      return (
        (tauri && tauri.metadata && tauri.metadata.currentWindow.label) ||
        'main'
      )
    } catch {
      return 'main'
    }
  }

  function isWindows() {
    return /Windows/i.test(navigator.userAgent)
  }

  // ----- appearance --------------------------------------------------------

  function applyTheme() {
    var dark
    try {
      var stored = JSON.parse(localStorage.getItem('theme') || 'null')
      var theme = stored && stored.state && stored.state.activeTheme
      if (theme === 'dark') dark = true
      if (theme === 'light') dark = false
    } catch {
      // No stored theme, or storage is unavailable: follow the OS.
    }
    if (dark === undefined) {
      dark = Boolean(
        window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches
      )
    }
    loader.setAttribute('data-theme', dark ? 'dark' : 'light')
  }

  function setStatus(label) {
    if (statusEl && label) statusEl.textContent = label
  }

  // ----- the problem panel -------------------------------------------------

  function renderErrors() {
    if (!problemErrorsEl) return
    problemErrorsEl.textContent = state.errors.join('\n')
    problemErrorsEl.hidden = state.errors.length === 0
  }

  function showProblem(kind) {
    if (state.ready || !problemEl) return
    state.problem = kind
    var seconds = Math.round((Date.now() - state.stepAt) / 1000)
    if (problemTitleEl) {
      problemTitleEl.textContent =
        kind === 'failed'
          ? "Radium didn't finish starting"
          : 'Radium is taking longer than usual to start'
    }
    if (problemDetailEl) {
      problemDetailEl.textContent =
        'Stopped at: ' +
        (state.label || state.id) +
        ' (' +
        seconds +
        ' s). The log has the details.'
    }
    renderErrors()
    if (keepWaitingButton) keepWaitingButton.hidden = false
    problemEl.hidden = false
    loader.setAttribute('data-state', 'problem')
    log(
      kind === 'failed' ? ERROR : WARN,
      'showing the "' +
        kind +
        '" panel after ' +
        elapsed() +
        ' ms at step ' +
        state.id
    )
  }

  function hideProblem() {
    if (!problemEl) return
    state.problem = null
    problemEl.hidden = true
    loader.setAttribute('data-state', 'booting')
  }

  // ----- timers ------------------------------------------------------------

  function armStallTimer() {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(function () {
      showProblem(state.errors.length ? 'failed' : 'stalled')
    }, STALL_MS)
  }

  function stopTimers() {
    clearTimeout(stallTimer)
    clearTimeout(errorTimer)
    clearInterval(heartbeat)
  }

  // ----- errors before the app is up ---------------------------------------

  function noteError(message) {
    if (state.ready) return
    if (state.errors.length < MAX_ERRORS) state.errors.push(message)
    renderErrors()
    log(ERROR, 'error before the app was ready: ' + message)
    // One error is not always fatal - the app may still draw. Give it a
    // moment, then say so if nothing has moved since.
    var seqAtError = state.seq
    clearTimeout(errorTimer)
    errorTimer = setTimeout(function () {
      if (!state.ready && state.seq === seqAtError) showProblem('failed')
    }, AFTER_ERROR_MS)
  }

  window.addEventListener(
    'error',
    function (event) {
      var target = event && event.target
      if (target && target !== window && target.tagName) {
        // A script or stylesheet that failed to load stops the app; an image
        // that failed to load does not.
        if (target.tagName === 'SCRIPT' || target.tagName === 'LINK') {
          noteError('Could not load ' + (target.src || target.href))
        }
        return
      }
      noteError(describe((event && (event.error || event.message)) || event))
    },
    true
  )

  window.addEventListener('unhandledrejection', function (event) {
    noteError(describe(event && event.reason))
  })

  // ----- buttons -----------------------------------------------------------

  function openLog() {
    invoke('get_app_configurations')
      .then(function (config) {
        var folder = config && config.data_folder
        if (!folder) throw new Error('no data folder')
        var sep = folder.indexOf('\\') !== -1 ? '\\' : '/'
        return invoke('plugin:opener|reveal_item_in_dir', {
          paths: [folder + sep + 'logs' + sep + 'app.log'],
        })
      })
      .catch(function (error) {
        log(WARN, 'could not open the log folder: ' + describe(error))
      })
  }

  var actions = {
    wait: function () {
      log(INFO, 'user chose to keep waiting at step ' + state.id)
      hideProblem()
      armStallTimer()
    },
    restart: function () {
      log(INFO, 'user chose to restart at step ' + state.id)
      invoke('relaunch').catch(function () {
        window.location.reload()
      })
    },
    log: openLog,
    minimize: function () {
      invoke('plugin:window|minimize', { label: windowLabel() }).catch(function () {})
    },
    close: function () {
      log(INFO, 'window closed from the boot screen at step ' + state.id)
      invoke('plugin:window|close', { label: windowLabel() }).catch(function () {})
    },
  }

  loader.addEventListener('click', function (event) {
    var button = event.target && event.target.closest
      ? event.target.closest('[data-boot-action]')
      : null
    if (!button) return
    var action = actions[button.getAttribute('data-boot-action')]
    if (action) action()
  })

  // ----- the API the app calls ---------------------------------------------

  function dismiss(reason) {
    if (state.ready) return
    state.ready = true
    stopTimers()
    log(INFO, 'ready (' + reason + ') after ' + elapsed() + ' ms')
    document.body.classList.add('loaded')
    setTimeout(function () {
      if (loader.parentNode) loader.parentNode.removeChild(loader)
    }, FADE_MS)
  }

  window.__radiumBoot = {
    /** Record a startup step and show its label. */
    step: function (id, label) {
      if (state.ready) return
      state.id = id
      state.label = label || state.label
      state.stepAt = Date.now()
      state.seq += 1
      setStatus(label)
      log(INFO, '+' + elapsed() + ' ms ' + id + (label ? ': ' + label : ''))
      if (state.problem === 'stalled') hideProblem()
      armStallTimer()
    },
    /** The app has drawn: fade the boot screen out. */
    ready: function (reason) {
      dismiss(reason || 'app drawn')
    },
    /** Startup failed in a way the app knows about. */
    fail: function (error, where) {
      if (where) state.label = where
      noteError(describe(error))
      showProblem('failed')
    },
    /** Write one line to app.log (level: 3 info, 4 warn, 5 error). */
    log: function (level, message) {
      invoke('plugin:log|log', { level: level, message: message }).catch(
        function () {}
      )
    },
  }

  // ----- start -------------------------------------------------------------

  applyTheme()
  // Only the main window is created without a native title bar (see
  // src/lib/window-chrome.ts); the logs and system-monitor windows keep theirs.
  if (internals() && isWindows() && windowLabel() === 'main') {
    loader.setAttribute('data-chrome', 'custom')
  }
  log(INFO, 'boot screen up (' + navigator.userAgent + ')')
  armStallTimer()
  heartbeat = setInterval(function () {
    if (state.ready) return
    log(
      INFO,
      'still starting: ' +
        state.id +
        ' for ' +
        Math.round((Date.now() - state.stepAt) / 1000) +
        ' s'
    )
  }, HEARTBEAT_MS)
})()
