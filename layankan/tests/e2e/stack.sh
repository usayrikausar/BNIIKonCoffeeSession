#!/usr/bin/env bash
# Local end-to-end stack: Postgres + PostgREST (behind a /rest/v1 proxy) + fake
# Claude / Meta Graph / Murpati / Billplz + `next start`. No Docker, no accounts.
#   bash tests/e2e/stack.sh up     # build + start (≈1 min)
#   bash tests/e2e/stack.sh down
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"; APP="$E/../.."
RUN=/tmp/layankan-e2e; PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
SERVICE=$(node "$E/jwt.mjs" role service_role); ANON=$(node "$E/jwt.mjs" role anon)
KEY=$(node -e 'console.log(Buffer.alloc(32, 7).toString("base64"))')

down() {
  ps -eo pid,args | awk '$2=="next-server" || $2 ~ /postgrest$/ || ($2=="node" && $3 ~ /fake-services.mjs$/) {print $1}' | xargs -r kill 2>/dev/null || true
  [ -d $RUN/pg/data ] && su postgres -s /bin/bash -c "$PGBIN/pg_ctl -D $RUN/pg/data stop -m fast" >/dev/null 2>&1 || true
  rm -rf $RUN
}
run() { if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "PATH=$PGBIN:\$PATH $*"; else bash -c "PATH=$PGBIN:\$PATH $*"; fi; }

if [ "${1:-up}" = "down" ]; then down; exit 0; fi
down; mkdir -p $RUN/pg; chmod 777 $RUN/pg
if [ ! -x "$E/.bin/postgrest" ]; then
  mkdir -p "$E/.bin"; curl -sSL https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz | tar -xJ -C "$E/.bin"
fi
run "initdb -D $RUN/pg/data -U postgres >/dev/null"
run "pg_ctl -D $RUN/pg/data -o '-p 54330 -k $RUN/pg -c listen_addresses=127.0.0.1' -l $RUN/pg/log start >/dev/null"
P="psql -h 127.0.0.1 -p 54330 -U postgres -d postgres -q -v ON_ERROR_STOP=1"
$P -f "$APP/supabase/tests/supabase_shim.sql"
for f in "$APP"/supabase/migrations/*.sql; do $P -f "$f"; done
$P -f "$APP/supabase/seed.sql" >/dev/null
$P -f "$E/fixtures.sql" >/dev/null
$P -c "create role authenticator login noinherit password 'pw'; grant anon, authenticated, service_role to authenticator;"
cat > $RUN/pgrst.conf <<CONF
db-uri = "postgres://authenticator:pw@127.0.0.1:54330/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$(node -e 'import("'"$E"'/jwt.mjs").then(m=>console.log(m.SECRET))')"
server-port = 3001
CONF
("$E/.bin/postgrest" $RUN/pgrst.conf > $RUN/pgrst.log 2>&1 &)
(node "$E/fake-services.mjs" > $RUN/fake.log 2>&1 &)
cd "$APP"
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON NEXT_PUBLIC_APP_URL=http://localhost:3000 NEXT_TELEMETRY_DISABLED=1
npx next build > $RUN/build.log 2>&1
(SUPABASE_SERVICE_ROLE_KEY=$SERVICE ANTHROPIC_API_KEY=sk-fake ANTHROPIC_BASE_URL=http://127.0.0.1:4010 CRON_SECRET=testcron \
  ENCRYPTION_KEYS="k1:$KEY" META_APP_SECRET=metasecret META_WEBHOOK_VERIFY_TOKEN=verifyme META_GRAPH_BASE_URL=http://127.0.0.1:4010 BILLPLZ_API_BASE_URL=http://127.0.0.1:4010 TOYYIBPAY_API_BASE_URL=http://127.0.0.1:4010 \
  BILLING_GATEWAY=manual PLATFORM_ADMIN_EMAILS=admin@layankan.test npx next start -p 3000 > $RUN/next.log 2>&1 &)
for i in $(seq 1 30); do curl -sf -o /dev/null localhost:3000/ && break; sleep 1; done
echo "stack up: app http://localhost:3000 · logs in $RUN"
