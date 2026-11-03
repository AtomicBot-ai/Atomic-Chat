#!/bin/sh
# After an upgrade, a running Atomic Chat keeps the previous version: closing the window only hides it in
# the tray, a second launch shows that same window, and its core keeps running. Should that core restart
# before the app does, the old app would start the new core binary and refuse to attach to it. dpkg passes
# `configure <old-version>` (no old version on a first install); rpm passes the number of installed
# instances (2 during an upgrade). Nothing to say on a first install. packaging/atomic-chat-bin.install
# says the same for pacman.
case "${1:-}" in
  configure) [ -n "${2:-}" ] || exit 0 ;;
  [0-9]*) [ "$1" -ge 2 ] || exit 0 ;;
  *) exit 0 ;;
esac
echo 'Atomic Chat: a running Atomic Chat keeps the previous version; quit it (tray menu, Quit) and start it again.'
exit 0
