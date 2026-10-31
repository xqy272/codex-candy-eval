#!/usr/bin/env bash
set -euo pipefail
taskroot="$(cd -- "$(dirname -- "$0")/.." && pwd)/.runtime/integration-deps"
mkdir -p "$taskroot/debs" "$taskroot/tools"
cd "$taskroot/debs"
apt-get download postgresql-16 postgresql-client-16 libpq5 libllvm17t64 redis-server redis-tools liblzf1 libjemalloc2 libatomic1
for package in ./*.deb; do dpkg-deb -x "$package" "$taskroot/tools"; done
ldd "$taskroot/tools/usr/lib/postgresql/16/bin/postgres" | tail -8
ldd "$taskroot/tools/usr/bin/redis-server" | tail -8
echo "Tools extracted without installing or starting system services"
