// Mobile-specific viewport and styling setup
export const setupMobileViewport = () => {
  // A desktop window can start narrow (including during onboarding). Its
  // width must never install the permanent mobile input-size override.
  const isMobile =
    IS_IOS ||
    IS_ANDROID ||
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  if (isMobile) {
    // Update viewport meta tag to disable zoom
    const viewportMeta = document.querySelector('meta[name="viewport"]')
    if (viewportMeta) {
      viewportMeta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
      )
    }

    // Add mobile-specific styles for status bar
    const style = document.createElement('style')
    style.textContent = `
      body {
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }

      #root {
        min-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
      }

      /* Prevent zoom on input focus */
      input, textarea, select {
        font-size: max(16px, var(--font-size-base, 16px)) !important;
      }
    `
    document.head.appendChild(style)
  }
}
