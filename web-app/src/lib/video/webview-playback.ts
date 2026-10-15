/**
 * What the webview may do with a clip on its own.
 *
 * WebKitGTK (Linux) plays `<video>` through the host's GStreamer. On a host
 * whose GStreamer is incomplete — the log says "GStreamer element
 * autoaudiosink not found", i.e. gst-plugins-good is not visible to the web
 * process — building a clip's pipeline hangs the web process, and the whole
 * window with it (Hyprland on Omarchy, 2026-10-15). So on Linux nothing
 * builds one until the user asks to play: no player on page open, no poster
 * capture in the background.
 */

/** Whether the page may load clips into the webview without the user asking. */
export const webviewAutoloadsVideo = (): boolean => !IS_LINUX

/** The media type of a gallery clip, by its container. */
export const clipMediaType = (path: string): string =>
  /\.mp4$/i.test(path) ? 'video/mp4' : 'video/webm'

/**
 * Whether the webview says it can decode the clip. WebKitGTK answers from the
 * GStreamer registry without building a pipeline, so a host missing the
 * demuxer is caught here instead of hanging in the player.
 */
export const webviewCanPlay = (path: string): boolean =>
  document.createElement('video').canPlayType(clipMediaType(path)) !== ''
