#!/usr/bin/env bash
# Run locally on Hetzner after merging the reviewed branch, preserving local fixes.
set -euo pipefail
umask 077
config=/root/.automaton/automaton.json
service=automaton
with_agentkit=1
while (($#)); do
  case "$1" in
    --config) config=${2:?}; shift 2 ;;
    --service) service=${2:?}; shift 2 ;;
    --without-agentkit) with_agentkit=0; shift ;;
    *) echo 'Usage: deploy-trading-runtime.sh [--config ABS] [--service NAME] [--without-agentkit]' >&2; exit 2 ;;
  esac
done
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
[[ $config = /* && -f $config && ! -L $config ]] || { echo 'Regular absolute runtime config required' >&2; exit 2; }
[[ $(systemctl show --property WorkingDirectory --value "$service") = "$repo" ]] || { echo 'Service WorkingDirectory differs; review deployment manually' >&2; exit 2; }
git diff --quiet
git diff --cached --quiet
revision=$(git rev-parse --short=12 HEAD)
pnpm install --frozen-lockfile
pnpm run typecheck
stage=$(mktemp -d "$repo/.trading-build.XXXXXX")
stopped=0
cleanup() {
  rm -rf -- "$stage"
  if [[ $stopped = 1 ]]; then echo 'Automaton is stopped after an incomplete deployment. Inspect its private backup before restarting it.' >&2; fi
}
trap cleanup EXIT
pnpm exec tsc --outDir "$stage/dist"
chmod -R u+rwX,go+rX "$stage/dist"
if [[ $with_agentkit = 1 ]]; then
  NODE_OPTIONS=--max-old-space-size=384 npm ci --prefix integrations/coinbase-agentkit --ignore-scripts --no-audit --no-fund
  npm test --prefix integrations/coinbase-agentkit
fi
backup="$(dirname "$(dirname "$config")")/automaton-runtime-backups/trading-$revision-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -m 700 "$backup"
systemctl stop "$service"
stopped=1
python3 - "$config" "$backup" <<'PY'
import json, os, pathlib, shutil, sqlite3, sys
config, backup = map(pathlib.Path, sys.argv[1:])
shutil.copy2(config, backup / 'automaton.json')
os.chmod(backup / 'automaton.json', 0o600)
data = json.loads(config.read_text())
database = pathlib.Path(data['dbPath']).expanduser().resolve()
if database.exists():
    source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    destination = sqlite3.connect(backup / 'state.db')
    with destination:
        source.backup(destination)
    source.close()
    destination.close()
    os.chmod(backup / 'state.db', 0o600)
print('Private runtime config/database backup completed; no secrets displayed.')
PY
python3 scripts/install-trading-skills.py --directory "$(dirname "$config")/skills"
python3 scripts/configure-runtime-trading.py --config "$config" --mode on
[[ ! -d dist ]] || mv -- dist "$backup/dist"
mv -- "$stage/dist" dist
systemctl start "$service"
stopped=0
sleep 2
systemctl is-active --quiet "$service"
printf 'Runtime updated to %s. Tools and report sync enabled; guardian live/paper authority unchanged.\n' "$revision"
printf 'Private backup: %s\n' "$backup"
