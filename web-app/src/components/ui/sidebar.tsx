'use client'

import { Slot } from '@radix-ui/react-slot'
import { type VariantProps, cva } from 'class-variance-authority'
import { PanelLeft } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { attachMediaListener } from '@/hooks/useMediaQuery'
import { useSidebarResize } from '@/hooks/use-sidebar-resize'
import { cn } from '@/lib/utils'

const SIDEBAR_COOKIE_NAME = 'sidebar:state'
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = '15rem'
const SIDEBAR_WIDTH_MOBILE = '18rem'
const SIDEBAR_WIDTH_ICON = '5rem'

//* new constants for sidebar resizing
const MIN_SIDEBAR_WIDTH = '14rem'
const MAX_SIDEBAR_WIDTH = '40rem'
/** One arrow-key press on the resize handle, in px (Shift moves four). */
const SIDEBAR_RESIZE_STEP = 16

/** A `rem` or `px` width in px (the root font size is fixed at 16 px). */
function widthToPx(width: string): number {
  const value = Number.parseFloat(width)
  if (!Number.isFinite(value)) return 0
  return width.trim().endsWith('rem') ? value * 16 : value
}

function pxToRem(px: number): string {
  return `${Number((px / 16).toFixed(4))}rem`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** True while the window is narrower than `px` (never when `px` is unset). */
function useWindowNarrowerThan(px: number | undefined): boolean {
  const query = px === undefined ? undefined : `(max-width: ${px - 0.02}px)`
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (!query || typeof window.matchMedia !== 'function') return () => {}
      return attachMediaListener(window.matchMedia(query), onChange)
    },
    [query]
  )
  return React.useSyncExternalStore(
    subscribe,
    () =>
      !!query &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false
  )
}

function subscribeToWindowResize(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

function useWindowWidth(): number {
  return React.useSyncExternalStore(
    subscribeToWindowResize,
    () => window.innerWidth,
    () => 0
  )
}

/**
 * Layers that open from inside the sidebar but render elsewhere (menus,
 * popovers, dialogs). A press inside one never closes the overlay.
 */
const SIDEBAR_OVERLAY_LAYERS =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"]'

type SidebarContext = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  //* new properties for sidebar resizing
  width: string
  setWidth: (width: string) => void
  //* new properties for tracking is dragging rail
  isDraggingRail: boolean
  setIsDraggingRail: (isDraggingRail: boolean) => void
  /**
   * The window is too narrow to dock the sidebar beside the page, so it opens
   * over the page instead. While this holds, `open` is that overlay's state,
   * not the saved preference, and setting it leaves the preference alone.
   */
  compact: boolean
  /**
   * Px the window keeps for the chrome left of the sidebar plus the page's
   * minimum width; the docked sidebar never grows into it. Unset when the
   * sidebar's width is not bounded by the window.
   */
  reservedWidth?: number
}

const SidebarContext = React.createContext<SidebarContext | null>(null)

/** The desktop panel is folded off-canvas: its sections render `inert`. */
const SidebarSlidAwayContext = React.createContext(false)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }

  return context
}

/**
 * Whether the sidebar takes room beside the page right now: open and docked
 * (not lying over the page in a compact window, not the mobile sheet). False
 * outside a SidebarProvider.
 */
function useSidebarDocked(): boolean {
  const context = React.useContext(SidebarContext)
  return !!context && context.open && !context.compact && !context.isMobile
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    defaultOpen?: boolean
    open?: boolean
    onOpenChange?: (open: boolean) => void
    //* new prop for default width
    defaultWidth?: string
    //* new prop for width change callback
    onWidthChange?: (width: string) => void
    /**
     * The narrowest the page beside the docked sidebar may get, in px. The
     * sidebar narrows to keep it, and once even its minimum width would not,
     * it stops docking and opens over the page (`compact`). Unset: the
     * sidebar always docks at its saved width.
     */
    minInsetWidth?: number
    /** Px taken left of the sidebar (the navigation rail). */
    insetOffset?: number
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange: setOpenProp,
      className,
      style,
      children,
      defaultWidth = SIDEBAR_WIDTH,
      onWidthChange,
      minInsetWidth,
      insetOffset = 0,
      ...props
    },
    ref
  ) => {
    const isMobile = useIsMobile()
    //* new state for sidebar width
    const [width, setWidthState] = React.useState(defaultWidth)

    //* wrapper to call both internal state and external callback
    const setWidth = React.useCallback(
      (newWidth: string) => {
        setWidthState(newWidth)
        onWidthChange?.(newWidth)
      },
      [onWidthChange]
    )
    const [openMobile, setOpenMobile] = React.useState(false)
    //* new state for tracking is dragging rail
    const [isDraggingRail, setIsDraggingRail] = React.useState(false)

    const reservedWidth =
      minInsetWidth === undefined ? undefined : insetOffset + minInsetWidth
    const compact = useWindowNarrowerThan(
      reservedWidth === undefined
        ? undefined
        : reservedWidth + widthToPx(MIN_SIDEBAR_WIDTH)
    )
    // The overlay a compact window opens. Crossing the breakpoint either way
    // closes it, so a docked spell never brings an old overlay back.
    const [overlayOpen, setOverlayOpen] = React.useState(false)
    const [overlayMode, setOverlayMode] = React.useState(compact)
    if (overlayMode !== compact) {
      setOverlayMode(compact)
      setOverlayOpen(false)
    }

    // This is the internal state of the sidebar.
    // We use openProp and setOpenProp for control from outside the component.
    const [_open, _setOpen] = React.useState(defaultOpen)
    const open = compact
      ? overlayMode === compact && overlayOpen
      : (openProp ?? _open)
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === 'function' ? value(open) : value
        // Opening or closing the overlay is not a preference: widening the
        // window brings back the sidebar the user left.
        if (compact) {
          setOverlayOpen(openState)
          return
        }
        if (setOpenProp) {
          setOpenProp(openState)
        } else {
          _setOpen(openState)
        }

        // This sets the cookie to keep the sidebar state.
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
      },
      [setOpenProp, open, compact]
    )

    // Helper to toggle the sidebar.
    const toggleSidebar = React.useCallback(() => {
      return isMobile
        ? setOpenMobile((open) => !open)
        : setOpen((open) => !open)
    }, [
      isMobile,
      setOpen,
      //* remove setOpenMobile from dependencies because setOpenMobile are state setters created by useState
      // setOpenMobile
    ])

    // The toggle shortcut is the app's (`KeyboardShortcutsProvider`, which
    // calls `toggleSidebar`); a second listener here would toggle it twice.

    // We add a state so that we can do data-state="expanded" or "collapsed".
    // This makes it easier to style the sidebar with Tailwind classes.
    const state = open ? 'expanded' : 'collapsed'

    const contextValue = React.useMemo<SidebarContext>(
      () => ({
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
        //* new context for sidebar resizing
        width,
        setWidth,
        //* new context for tracking is dragging rail
        isDraggingRail,
        setIsDraggingRail,
        compact,
        reservedWidth,
      }),
      [
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        //* remove setOpenMobile from dependencies because setOpenMobile are state setters created by useState
        // setOpenMobile,
        toggleSidebar,
        //* add width to dependencies
        width,
        //* add isDraggingRail to dependencies
        isDraggingRail,
        compact,
        reservedWidth,
      ]
    )

    // The saved width, held to its bounds; docked, it also gives way to the
    // page's minimum width as the window narrows (the saved value is kept for
    // a wider window).
    const boundedWidth = `${clamp(
      widthToPx(width),
      widthToPx(MIN_SIDEBAR_WIDTH),
      widthToPx(MAX_SIDEBAR_WIDTH)
    )}px`
    const sidebarWidth =
      reservedWidth === undefined
        ? width
        : compact
          ? boundedWidth
          : `min(${boundedWidth}, calc(100vw - ${reservedWidth}px))`

    return (
      <SidebarContext.Provider value={contextValue}>
        <TooltipProvider delayDuration={0}>
          <div
            style={
              {
                // * update '--sidebar-width' to use the new width state
                '--sidebar-width': sidebarWidth,
                '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
                ...style,
              } as React.CSSProperties
            }
            className={cn(
              'group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar',
              className
            )}
            ref={ref}
            {...props}
          >
            {children}
          </div>
        </TooltipProvider>
      </SidebarContext.Provider>
    )
  }
)
SidebarProvider.displayName = 'SidebarProvider'

const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    side?: 'left' | 'right'
    variant?: 'sidebar' | 'floating' | 'inset'
    collapsible?: 'offcanvas' | 'icon' | 'none'
  }
>(
  (
    {
      side = 'left',
      variant = 'sidebar',
      collapsible = 'offcanvas',
      className,
      children,
      onClick,
      ...props
    },
    ref
  ) => {
    const {
      isMobile,
      state,
      openMobile,
      setOpenMobile,
      //* new property for tracking is dragging rail
      isDraggingRail,
      compact,
      setOpen,
    } = useSidebar()
    // Open in a window too narrow to dock it: the panel lies over the page.
    const overlay = compact && state === 'expanded' && !isMobile
    const panelRef = React.useRef<HTMLDivElement>(null)

    // The overlay closes on Escape and on a press on the page beside it. The
    // rail and the title bar (with the toggle) sit left of and above the
    // panel, so pressing them leaves it to them.
    React.useEffect(() => {
      if (!overlay) return
      const onPointerDown = (event: PointerEvent) => {
        const panel = panelRef.current
        if (!panel) return
        const box = panel.getBoundingClientRect()
        if (event.clientX <= box.right || event.clientY < box.top) return
        if (
          event.target instanceof Element &&
          event.target.closest(SIDEBAR_OVERLAY_LAYERS)
        )
          return
        setOpen(false)
      }
      const onKeyDown = (event: KeyboardEvent) => {
        // A menu or dialog over the sidebar takes its own Escape first.
        if (event.key !== 'Escape' || event.defaultPrevented) return
        setOpen(false)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown)
      }
    }, [overlay, setOpen])

    // Slid fully away (folded off-canvas), the panel's rows are out of reach:
    // `inert` takes them out of the tab order and the accessibility tree. The
    // icon mode keeps its icons usable, and the resize handle stays live so
    // the panel can still be dragged back out.
    const slidAway =
      !isMobile && state === 'collapsed' && collapsible === 'offcanvas'
    // Focus inside a panel that folds would be left on a hidden row: hand it
    // to the toggle. Runs before the browser drops focus from the now-inert
    // rows.
    const wasExpanded = React.useRef(state === 'expanded')
    React.useLayoutEffect(() => {
      const folded = wasExpanded.current && state === 'collapsed'
      wasExpanded.current = state === 'expanded'
      if (!folded || isMobile) return
      if (!panelRef.current?.contains(document.activeElement)) return
      document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.focus()
    }, [state, isMobile])

    // Picking a page in the overlay closes it, so the page shows. Row actions
    // (pin, the "…" menu) and group toggles leave it open.
    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
      onClick?.(event)
      if (!overlay) return
      const target = event.target
      // Clicks bubbling from a portal (a row's menu) are not in the panel.
      if (!(target instanceof Element) || !panelRef.current?.contains(target))
        return
      if (target.closest('[data-sidebar="menu-action"]')) return
      if (
        target.closest(
          'a[href], [data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]'
        )
      ) {
        setOpen(false)
      }
    }

    if (collapsible === 'none') {
      return (
        <div
          className={cn(
            'flex h-full w-(--sidebar-width) flex-col bg-clip-padding bg-linear-to-b from-sidebar dark:from-sidebar/70 to-background text-sidebar-foreground',
            className
          )}
          ref={ref}
          onClick={onClick}
          {...props}
        >
          {children}
        </div>
      )
    }

    if (isMobile) {
      return (
        <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
          <SheetContent
            data-sidebar="sidebar"
            data-mobile="true"
            className="w-(--sidebar-width) bg-clip-padding bg-linear-to-b from-sidebar dark:from-sidebar/70 to-background p-0 text-sidebar-foreground [&>button]:hidden"
            style={
              {
                '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
            side={side}
          >
            <div className="flex h-full w-full flex-col">{children}</div>
          </SheetContent>
        </Sheet>
      )
    }

    return (
      <div
        ref={ref}
        className="group peer hidden md:block text-sidebar-foreground"
        data-state={state}
        data-collapsible={state === 'collapsed' ? collapsible : ''}
        data-variant={variant}
        data-side={side}
        //* add data-dragging attribute
        data-dragging={isDraggingRail}
        data-overlay={overlay}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          className={cn(
            'duration-200 relative h-svh w-(--sidebar-width) bg-transparent transition-[width] ease-linear',
            'group-data-[collapsible=offcanvas]:w-0',
            // Over the page, the panel takes no room from it.
            'group-data-[overlay=true]:w-0',
            'group-data-[side=right]:rotate-180',
            variant === 'floating' || variant === 'inset'
              ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
              : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
            //* set duration to 0 for all elements when dragging
            'group-data-[dragging=true]:duration-0! group-data-[dragging=true]_*:duration-0!'
          )}
        />
        <div
          className={cn(
            // The app shell can reserve a title bar row above the panel and a
            // navigation rail to its left; both default to 0 outside it.
            'duration-200 fixed bottom-0 top-[var(--window-titlebar-height,0px)] z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] ease-linear md:flex',
            side === 'left'
              ? 'left-[var(--navigation-rail-width,0px)] group-data-[collapsible=offcanvas]:left-[calc(var(--navigation-rail-width,0px)-var(--sidebar-width))]'
              : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
            // Adjust the padding for floating and inset variants.
            variant === 'floating' || variant === 'inset'
              ? 'p-2 pr-0 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
              : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
            //* set duration to 0 for all elements when dragging
            'group-data-[dragging=true]:duration-0! group-data-[dragging=true]_*:duration-0!',
            className
          )}
          {...props}
          ref={panelRef}
          onClick={handleClick}
        >
          <div
            data-sidebar="sidebar"
            className={cn(
              'relative flex h-full w-full flex-col bg-clip-padding bg-linear-to-b from-sidebar dark:from-sidebar/70 to-background',
              'group-data-[variant=floating]:rounded-xl group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow',
              // Over the page the translucent dark gradient gets the same
              // backdrop it has when docked, and a deeper shadow lifts it.
              'group-data-[overlay=true]:bg-background group-data-[overlay=true]:shadow-lg'
            )}
          >
            <SidebarSlidAwayContext.Provider value={slidAway}>
              {children}
            </SidebarSlidAwayContext.Provider>
          </div>
        </div>
      </div>
    )
  }
)
Sidebar.displayName = 'Sidebar'

const SidebarTrigger = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn('size-8', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
})
SidebarTrigger.displayName = 'SidebarTrigger'

/**
 * The resize handle on the sidebar's edge: drag it, or focus it and use the
 * arrow keys (Shift for bigger steps), Home and End; double-click puts the
 * default width back. The width stays between the minimum and, docked, what
 * leaves the page its minimum width; it is saved through `onWidthChange`.
 * Dragging well past the minimum folds the sidebar away, as before.
 */
const SidebarRail = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    //* new prop for enabling drag
    enableDrag?: boolean
  }
>(
  (
    { className, enableDrag = true, onKeyDown, onDoubleClick, ...props },
    ref
  ) => {
    const {
      toggleSidebar,
      setWidth,
      state,
      width,
      setIsDraggingRail,
      compact,
      reservedWidth,
    } = useSidebar()
    const windowWidth = useWindowWidth()

    const minPx = widthToPx(MIN_SIDEBAR_WIDTH)
    const maxPx =
      reservedWidth === undefined
        ? widthToPx(MAX_SIDEBAR_WIDTH)
        : clamp(
            windowWidth - reservedWidth,
            minPx,
            widthToPx(MAX_SIDEBAR_WIDTH)
          )
    // What the panel shows: the saved width within today's bounds.
    const currentPx = clamp(widthToPx(width), minPx, maxPx)
    const collapsed = state === 'collapsed'

    const { dragRef, handleMouseDown } = useSidebarResize({
      direction: 'right',
      // The panel no longer starts at the window edge (the navigation rail sits
      // to its left), so width follows the drag delta rather than clientX.
      isNested: true,
      enableDrag,
      // A click is half of a double-click (reset), not a toggle.
      enableToggle: false,
      onResize: setWidth,
      onToggle: toggleSidebar,
      currentWidth: pxToRem(currentPx),
      isCollapsed: collapsed,
      minResizeWidth: MIN_SIDEBAR_WIDTH,
      maxResizeWidth: pxToRem(maxPx),
      setIsDraggingRail,
      widthCookieName: 'sidebar:width',
      widthCookieMaxAge: 60 * 60 * 24 * 7, // 1 week
    })

    //* Merge external ref with our dragRef
    const combinedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        // The resize hook types its ref as a button; it only measures the box.
        const handle = dragRef as unknown as React.RefObject<HTMLElement | null>
        handle.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      },
      [ref, dragRef]
    )

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      const step = SIDEBAR_RESIZE_STEP * (event.shiftKey ? 4 : 1)
      const next = {
        ArrowLeft: currentPx - step,
        ArrowRight: currentPx + step,
        Home: minPx,
        End: maxPx,
      }[event.key]
      if (next === undefined) return
      event.preventDefault()
      const bounded = clamp(next, minPx, maxPx)
      if (bounded !== currentPx) setWidth(pxToRem(bounded))
    }

    // Over the page (a compact window) there is nothing to make room for.
    if (compact) return null

    return (
      <div
        ref={combinedRef}
        data-sidebar="rail"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={Math.round(currentPx)}
        aria-valuemin={Math.round(minPx)}
        aria-valuemax={Math.round(maxPx)}
        aria-hidden={collapsed || undefined}
        tabIndex={collapsed ? -1 : 0}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        onDoubleClick={(event) => {
          onDoubleClick?.(event)
          setWidth(SIDEBAR_WIDTH)
        }}
        className={cn(
          //* No visible line (::after) on hover, only resizing and the cursor;
          // keyboard focus shows one so the handle can be found.
          'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 border-0 bg-transparent p-0 outline-none transition-all ease-linear sm:flex',
          'after:absolute after:inset-y-3 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full focus-visible:after:bg-ring',
          'group-data-[side=left]:-right-4 group-data-[side=right]:left-0',
          'cursor-ew-resize group-data-[side=left]:cursor-ew-resize group-data-[side=right]:cursor-ew-resize',
          '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
          'group-data-[collapsible=offcanvas]:translate-x-0',
          '[[data-side=left][data-collapsible=offcanvas]_&]:-right-1',
          '[[data-side=right][data-collapsible=offcanvas]_&]:-left-1',
          className
        )}
        {...props}
      />
    )
  }
)
SidebarRail.displayName = 'SidebarRail'

const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'main'>
>(({ className, ...props }, ref) => {
  const { compact, open, isMobile } = useSidebar()
  return (
    <main
      ref={ref}
      className={cn(
        'relative flex min-h-svh min-w-0 flex-1 flex-col bg-background',
        // While the sidebar lies over the page, the page's own raised layers
        // (the composer's z-50 "/" menu) stack inside the page, under it.
        // Only then: any press on the page closes the overlay first, so a
        // full-window layer the page opens is never held under the shell.
        compact && open && !isMobile && 'isolate',
        'peer-data-[variant=inset]:min-h-[calc(100svh-(--spacing(4)))] md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm',
        className
      )}
      {...props}
    />
  )
})
SidebarInset.displayName = 'SidebarInset'

const SidebarInput = React.forwardRef<
  React.ElementRef<typeof Input>,
  React.ComponentProps<typeof Input>
>(({ className, ...props }, ref) => {
  return (
    <Input
      ref={ref}
      data-sidebar="input"
      className={cn(
        'h-8 w-full bg-background shadow-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        className
      )}
      {...props}
    />
  )
})
SidebarInput.displayName = 'SidebarInput'

const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => {
  const slidAway = React.useContext(SidebarSlidAwayContext)
  return (
    <div
      ref={ref}
      data-sidebar="header"
      inert={slidAway || undefined}
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
})
SidebarHeader.displayName = 'SidebarHeader'

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => {
  const slidAway = React.useContext(SidebarSlidAwayContext)
  return (
    <div
      ref={ref}
      data-sidebar="footer"
      inert={slidAway || undefined}
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
})
SidebarFooter.displayName = 'SidebarFooter'

const SidebarSeparator = React.forwardRef<
  React.ElementRef<typeof Separator>,
  React.ComponentProps<typeof Separator>
>(({ className, ...props }, ref) => {
  return (
    <Separator
      ref={ref}
      data-sidebar="separator"
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      {...props}
    />
  )
})
SidebarSeparator.displayName = 'SidebarSeparator'

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => {
  const slidAway = React.useContext(SidebarSlidAwayContext)
  return (
    <div
      ref={ref}
      data-sidebar="content"
      inert={slidAway || undefined}
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className
      )}
      {...props}
    />
  )
})
SidebarContent.displayName = 'SidebarContent'

const SidebarGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  )
})
SidebarGroup.displayName = 'SidebarGroup'

const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'div'

  return (
    <Comp
      ref={ref}
      data-sidebar="group-label"
      className={cn(
        'duration-200 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-hidden ring-sidebar-ring transition-[margin,opa] ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className
      )}
      {...props}
    />
  )
})
SidebarGroupLabel.displayName = 'SidebarGroupLabel'

const SidebarGroupAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      ref={ref}
      data-sidebar="group-action"
      className={cn(
        'absolute right-3 top-3.5 flex aspect-square w-5 cursor-pointer items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'group-data-[collapsible=icon]:hidden',
        className
      )}
      {...props}
    />
  )
})
SidebarGroupAction.displayName = 'SidebarGroupAction'

const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group-content"
    className={cn('w-full text-sm', className)}
    {...props}
  />
))
SidebarGroupContent.displayName = 'SidebarGroupContent'

const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<'ul'>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn('flex w-full min-w-0 flex-col gap-1', className)}
    {...props}
  />
))
SidebarMenu.displayName = 'SidebarMenu'

const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<'li'>
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn('group/menu-item relative', className)}
    {...props}
  />
))
SidebarMenuItem.displayName = 'SidebarMenuItem'

const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'hover:bg-sidebar-foreground/8 hover:text-sidebar-accent-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    asChild?: boolean
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(
  (
    {
      asChild = false,
      isActive = false,
      variant = 'default',
      size = 'default',
      tooltip,
      className,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button'
    const { isMobile, state } = useSidebar()

    const button = (
      <Comp
        ref={ref}
        data-sidebar="menu-button"
        data-size={size}
        data-active={isActive}
        className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
        {...props}
      />
    )

    if (!tooltip) {
      return button
    }

    if (typeof tooltip === 'string') {
      tooltip = {
        children: tooltip,
      }
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          side="right"
          align="center"
          hidden={state !== 'collapsed' || isMobile}
          {...tooltip}
        />
      </Tooltip>
    )
  }
)
SidebarMenuButton.displayName = 'SidebarMenuButton'

const SidebarMenuAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    asChild?: boolean
    showOnHover?: boolean
  }
>(({ className, asChild = false, showOnHover = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-action"
      className={cn(
        'absolute right-1 top-1.5 flex aspect-square w-5 cursor-pointer items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground md:opacity-0',
        className
      )}
      {...props}
    />
  )
})
SidebarMenuAction.displayName = 'SidebarMenuAction'

const SidebarMenuBadge = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="menu-badge"
    className={cn(
      'absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums text-sidebar-foreground select-none pointer-events-none',
      'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
      'peer-data-[size=sm]/menu-button:top-1',
      'peer-data-[size=default]/menu-button:top-1.5',
      'peer-data-[size=lg]/menu-button:top-2.5',
      'group-data-[collapsible=icon]:hidden',
      className
    )}
    {...props}
  />
))
SidebarMenuBadge.displayName = 'SidebarMenuBadge'

const SidebarMenuSkeleton = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    showIcon?: boolean
  }
>(({ className, showIcon = false, ...props }, ref) => {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  }, [])

  return (
    <div
      ref={ref}
      data-sidebar="menu-skeleton"
      className={cn('rounded-md h-8 flex gap-2 px-2 items-center', className)}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 flex-1 max-w-(--skeleton-width)"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  )
})
SidebarMenuSkeleton.displayName = 'SidebarMenuSkeleton'

const SidebarMenuSub = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<'ul'>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu-sub"
    className={cn(
      'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5',
      'group-data-[collapsible=icon]:hidden',
      className
    )}
    {...props}
  />
))
SidebarMenuSub.displayName = 'SidebarMenuSub'

const SidebarMenuSubItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<'li'>
>(({ ...props }, ref) => <li ref={ref} {...props} />)
SidebarMenuSubItem.displayName = 'SidebarMenuSubItem'

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<'a'> & {
    asChild?: boolean
    size?: 'sm' | 'md'
    isActive?: boolean
  }
>(({ asChild = false, size = 'md', isActive, className, ...props }, ref) => {
  const Comp = asChild ? Slot : 'a'

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'flex h-7 min-w-0 -translate-x-px cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className
      )}
      {...props}
    />
  )
})
SidebarMenuSubButton.displayName = 'SidebarMenuSubButton'

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  useSidebarDocked,
}
