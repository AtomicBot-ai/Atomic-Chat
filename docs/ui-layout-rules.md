# UI layout rules

These rules exist because jsdom verifies markup, not geometry. A component can
pass every React test and still wrap, jump, clip an action or grow a horizontal
scrollbar in the desktop webview.

## Required checks

- Check **Medium** and **Extra Large** interface font sizes. Extra Large is a
  supported setting, not an edge case.
- Check a 1024 px desktop window with the sidebar open and the default 1280 px
  layout. Nothing may create horizontal scrolling.
- Check light and dark themes when a change touches fills, borders, icons or
  status colours.
- Use realistic worst-case copy: a long model id, a two-digit GB size, a
  three-digit percentage and a translated action wider than English.

## Component anatomy

- Every horizontal row must give its text column `min-width: 0`; names and
  secondary copy truncate or clamp before they can push the action away.
- Repeated row actions form one stable column. Loading, cancel and completed
  states occupy the same action slot and do not change the row width.
- Icons and logos use the component's documented slot size and align to the
  title block's vertical centre. Do not repair alignment with arbitrary top
  margins.
- Numeric progress readouts are one line, use tabular numbers and truncate the
  least important suffix first.
- A dialog or popover owns scrolling inside a bounded content region. Its
  shell must never become wider because one state has longer content.
- Async states replace content inside reserved geometry. Searching,
  downloading, starting and error states must not move the surrounding panel.
- Show a human display name once. Never concatenate a repo id, model id and
  pretty name into the same visible title.

## Automated gate

Run `make test-layout`. It launches headless Chromium with the app's Tailwind
CSS and bundled Inter font, then measures rendered boxes. Layout regressions
belong in a `*.layout.test.tsx` beside the component that broke.

Use the helpers in `web-app/src/test/layout.ts`:

- `expectNoHorizontalOverflow` for dialogs, cards and popovers;
- `expectOneLine` for hints and progress readouts;
- `expectSameWidth` / `expectSameHeight` for repeated rows or cards;
- `expectVerticallyCentered` and `expectTextCentered` for icon/text alignment.

A class-name assertion can complement a browser measurement, but cannot replace
it. When fixing a visual regression, add a failing browser measurement for the
reported state before changing the component.
