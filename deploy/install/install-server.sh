#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
case "${1:-}" in ''|--enable) ;; *) echo 'Usage: install-server.sh [--enable]' >&2; exit 2 ;; esac
command -v node >/dev/null
command -v npm >/dev/null
command -v systemctl >/dev/null
command -v useradd >/dev/null

source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
version=$(node -e 'const p=require(process.argv[1]); if(!/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(p.version)) process.exit(2); process.stdout.write(p.version)' "$source_dir/package.json")
target="/opt/privaproxy-$version"
link=/opt/privaproxy

[ -f "$source_dir/package-lock.json" ] || { echo 'package-lock.json is required.' >&2; exit 1; }
[ -f "$source_dir/bin/privaproxy.js" ] || { echo 'PrivaProxy entrypoint is missing.' >&2; exit 1; }
[ ! -e "$target" ] && [ ! -L "$target" ] || { echo "$target already exists; refusing to overwrite it." >&2; exit 1; }
[ ! -e "$link" ] && [ ! -L "$link" ] || { echo "$link already exists; use the PrivaNet updater for upgrades." >&2; exit 1; }
if find "$source_dir" -type l -print -quit | grep -q .; then
  echo 'Server release contains symbolic links before dependency installation; refusing it.' >&2
  exit 1
fi

if ! id privaproxy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/privaproxy --shell /usr/sbin/nologin privaproxy
fi

install -d -o root -g root -m 0755 /etc/privaproxy
install -d -o privaproxy -g privaproxy -m 0700 /var/lib/privaproxy /var/lib/privaproxy/cache
if [ ! -e /etc/privaproxy/privaproxy.env ]; then
  install -o root -g root -m 0600 "$source_dir/deploy/env/privaproxy.env.example" /etc/privaproxy/privaproxy.env
fi

install -d -o root -g root -m 0755 "$target"
cp -R "$source_dir/." "$target/"
umask 022
(cd "$target" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chown -R root:root "$target"
chmod 0755 "$target"
chmod -R go-w "$target"
ln -s "$target" "$link"
chown -h root:root "$link"

install -m 0644 "$source_dir/deploy/systemd/privaproxy.service" /etc/systemd/system/privaproxy.service
systemctl daemon-reload
if [ "${1:-}" = --enable ]; then
  systemctl enable --now privaproxy.service
fi

printf '%s\n' \
  "Installed PrivaProxy $version at $target" \
  'Config: /etc/privaproxy/privaproxy.env' \
  'State:  /var/lib/privaproxy' \
  'Future program updates: privanet-update --check / privanet-update'
