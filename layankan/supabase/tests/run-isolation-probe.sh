#!/usr/bin/env bash
# Runs the tenant-isolation PROBES (non-aborting; prints PASS/FAIL per probe) against a throwaway local Postgres.
# Needs PostgreSQL 15+ binaries (pg_ctl, initdb, psql) on PATH or in
# /usr/lib/postgresql/*/bin. No Docker, no Supabase account required.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PATH="$PGBIN:$PATH"

tmp="$(mktemp -d)"
port="${RLS_TEST_PORT:-54329}"
cleanup() { pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

run() { if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "PATH=$PATH $*"; else bash -c "$*"; fi; }
chmod 777 "$tmp"
run "initdb -D $tmp/data -U postgres >/dev/null"
run "pg_ctl -D $tmp/data -o '-p $port -k $tmp -c listen_addresses=' -l $tmp/log start >/dev/null"

PSQL=(psql -h "$tmp" -p "$port" -U postgres -v ON_ERROR_STOP=1 -q -d postgres)
"${PSQL[@]}" -f "$here/supabase_shim.sql"
for f in "$root"/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f "$root/seed.sql" >/dev/null
out="$("${PSQL[@]}" -f "$here/isolation_probe.sql" 2>&1 | grep -E "PASS \|| FAIL \|")"
echo "$out"
if echo "$out" | grep -q "FAIL |"; then echo "ISOLATION PROBE: FAILURES FOUND"; exit 1; fi
echo "ISOLATION PROBE: ALL PASS"
