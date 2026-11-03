#!/bin/sh
# Install Atomic Chat in a clean container the way README.md tells users to, then check what a packaged
# install promises: the version, the /opt layout with the package-managed marker (the updater stays off),
# the command, the menu entry and icon, a core whose Bun payload is intact, every ELF file's libraries
# found (the dependencies the stage read from them are complete), the app still running 20 s after it
# starts under Xvfb (what it opens at run time, like the tray library, is there too), and a removal that
# takes it all away. The release workflow runs it on the draft's packages, the linux-repo workflow on the
# published repository.
#
#   smoke-linux-package.sh apt|dnf <version> <file with the README's install commands>
#   smoke-linux-package.sh pacman <version> <directory with the PKGBUILD>
set -eu

manager=$1
version=$2
input=$3
opt=/opt/atomic-chat

fail() {
  echo "smoke: $*" >&2
  exit 1
}

# The README's commands use sudo; a container runs as root without it.
sudo_shim() {
  command -v sudo >/dev/null 2>&1 && return 0
  cat >/usr/local/bin/sudo <<'EOF'
#!/bin/sh
exec "$@"
EOF
  chmod +x /usr/local/bin/sudo
}

case $manager in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    echo 'APT::Get::Assume-Yes "true";' >/etc/apt/apt.conf.d/90-smoke
    apt-get update -qq
    apt-get install -qq curl ca-certificates xvfb dbus >/dev/null
    sudo_shim
    sh -eux "$input"
    installed=$(dpkg-query -W -f '${Version}' atomic-chat)
    ;;
  dnf)
    echo 'assumeyes=True' >>/etc/dnf/dnf.conf
    # Fedora ships curl-minimal, which a plain `dnf install curl` conflicts with.
    command -v curl >/dev/null 2>&1 || dnf install -q curl >/dev/null
    dnf install -q xorg-x11-server-Xvfb dbus-daemon >/dev/null
    sudo_shim
    sh -eux "$input"
    installed=$(rpm -q --qf '%{VERSION}' atomic-chat)
    ;;
  pacman)
    # pacman's download sandbox needs syscalls a container may not grant; the container is the sandbox.
    sed -i -e 's/^#DisableSandboxSyscalls/DisableSandboxSyscalls/' \
      -e 's/^#DisableSandboxFilesystem/DisableSandboxFilesystem/' /etc/pacman.conf
    pacman -Syu --noconfirm --needed base-devel sudo namcap xorg-server-xvfb dbus >/dev/null
    useradd -m builder
    echo 'builder ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/builder
    cp -r "$input" /home/builder/pkg
    chown -R builder /home/builder/pkg
    su builder -c 'cd ~/pkg && makepkg -si --noconfirm'
    # namcap is advice, not a gate: it flags things an -bin package does on purpose.
    namcap /home/builder/pkg/PKGBUILD /home/builder/pkg/*.pkg.tar.* || true
    installed=$(pacman -Q atomic-chat-bin | cut -d' ' -f2)
    ;;
  *) fail "unknown package manager $manager" ;;
esac

# nfpm writes 2.3.0-rc.1 as 2.3.0~rc.1 (deb 2.3.0~rc.1-1, rpm VERSION 2.3.0~rc.1); pacman has 2.3.0rc.1-1.
tilde=$(echo "$version" | tr - '~')
case $installed in
  "$tilde" | "$tilde-1" | "$(echo "$version" | tr -d -)-1") ;;
  *) fail "installed version is $installed, expected $version" ;;
esac

test -x "$opt/bin/Atomic-Chat" || fail "$opt/bin/Atomic-Chat is missing"
test "$(readlink -f /usr/bin/atomic-chat)" = "$opt/bin/Atomic-Chat" || fail "/usr/bin/atomic-chat does not point at $opt/bin/Atomic-Chat"
test -f "$opt/bin/atomic-chat-package-managed" || fail "the package-managed marker is missing: the updater would run"
for f in uv cloudflared bun; do test -x "$opt/bin/$f" || fail "$opt/bin/$f is missing"; done
test -d "$opt/lib/Atomic Chat/resources" || fail "the resources are not where Tauri looks for them"
test -s /usr/share/applications/chat.atomic.app.desktop || fail "the desktop entry is missing"
test -s /usr/share/icons/hicolor/128x128/apps/chat.atomic.app.png || fail "the icon is missing"
"$opt/lib/Atomic Chat/resources/bin/atomic-chat-core" --version >/dev/null || fail "the core does not run: its Bun payload is damaged"

missing=$(find "$opt" -type f | while IFS= read -r f; do
  [ "$(head -c 4 "$f" | od -An -c | tr -d ' \n')" = '177ELF' ] || continue
  ldd "$f" 2>/dev/null | grep 'not found' | sed "s|^|$f: |" || true
done)
[ -z "$missing" ] || fail "libraries the packages do not pull in:
$missing"

# The app with no tray host and no GPU: it must stay up, not exit on a library it opens late.
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
xvfb=$!
sleep 2
log=$(mktemp)
status=0
DISPLAY=:99 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 timeout 20 dbus-run-session -- atomic-chat >"$log" 2>&1 || status=$?
kill "$xvfb" 2>/dev/null || true
if [ "$status" != 124 ]; then
  tail -n 40 "$log" >&2
  fail "atomic-chat exited with $status within 20 s"
fi

case $manager in
  apt) apt-get remove -qq atomic-chat >/dev/null ;;
  dnf) dnf remove -q atomic-chat ;;
  pacman) pacman -R --noconfirm atomic-chat-bin >/dev/null ;;
esac
test ! -e /usr/bin/atomic-chat || fail "/usr/bin/atomic-chat is still there after removing the package"
test ! -e "$opt" || fail "$opt is still there after removing the package"
echo "smoke: Atomic Chat $version from $manager: ok"
