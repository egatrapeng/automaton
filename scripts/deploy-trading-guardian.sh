#!/usr/bin/env bash
# Trusted Hostinger operator only. No SSH, OS upgrade, wallet init or other service restart.
set -euo pipefail
umask 077
mode=paper
compose=/opt/wallet-guardian/compose.yaml
project=egatrap-wallet-guardian
vault=/var/lib/guardian-state/vault
while (($#)); do
  case "$1" in
    --mode) mode=${2:?}; shift 2 ;;
    --compose) compose=${2:?}; shift 2 ;;
    --project) project=${2:?}; shift 2 ;;
    *) echo 'Usage: deploy-trading-guardian.sh [--mode paper|live|off] [--compose ABS] [--project NAME]' >&2; exit 2 ;;
  esac
done
case "$mode" in paper|live|off) ;; *) echo 'Unknown mode' >&2; exit 2 ;; esac
[[ $compose = /* && -f $compose && ! -L $compose ]] || { echo 'Regular absolute Compose file required' >&2; exit 2; }
[[ -z ${COMPOSE_FILE:-} ]] || { echo 'Review COMPOSE_FILE overrides manually before using this helper' >&2; exit 2; }
deploy_root=$(dirname "$compose")
for name in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
  [[ ! -e "$deploy_root/$name" ]] || { echo 'An existing Compose override requires manual review; no changes made' >&2; exit 2; }
done
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
git diff --quiet
git diff --cached --quiet
revision=$(git rev-parse --short=12 HEAD)
image="local/wallet-guardian:trading-$revision"
base=(docker compose --project-name "$project" --file "$compose")
"${base[@]}" config --services | grep -Fx guardian >/dev/null
"${base[@]}" config --services | grep -Fx netns >/dev/null
docker build --file deploy/wallet-guardian/Dockerfile --tag "$image" .
override=$(mktemp /tmp/guardian-trading-override.XXXXXX.json)
printf '{"services":{"guardian":{"image":"%s","stop_grace_period":"130s"}}}\n' "$image" > "$override"
preview=(docker compose --project-name "$project" --file "$compose" --file "$override")
stopped=0
cleanup() {
  rm -f -- "$override"
  if [[ $stopped = 1 ]]; then
    echo 'Guardian is stopped after an incomplete deployment. Inspect the private backup and Compose; do not restore an old signer over an uncertain transaction.' >&2
  fi
}
trap cleanup EXIT
patch_compose() {
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
    --volume "$deploy_root:/deployment" --volume "$repo/scripts/patch-guardian-compose.mjs:/patch-compose.mjs:ro" \
    --entrypoint node "$image" /patch-compose.mjs "/deployment/$(basename "$compose")" "$image" "$@"
}
patch_compose
if [[ $mode != off ]]; then
  "${preview[@]}" run --rm --no-deps guardian trading-doctor --directory "$vault"
fi
backup="$deploy_root/backups/trading-$revision-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 700 -p "$backup"
cp -- "$compose" "$backup/compose.yaml"
"${base[@]}" stop --timeout 130 guardian
stopped=1
"${preview[@]}" run --rm --no-deps -T --entrypoint tar guardian \
  -C /var/lib/guardian-state -czf - vault > "$backup/guardian-state.tar.gz"
gzip -t "$backup/guardian-state.tar.gz"
"${preview[@]}" run --rm --no-deps guardian trading-configure --directory "$vault" --mode "$mode"
patch_compose --apply
"${base[@]}" config --quiet
"${base[@]}" up --detach --no-deps --no-build guardian
stopped=0
# Token stays inside the guardian container. No public port, no browser credential.
"${base[@]}" exec -T guardian node --input-type=module -e '
import fs from "node:fs";
const c=JSON.parse(fs.readFileSync("/var/lib/guardian-state/vault/guardian-policy.json","utf8"));
const token=fs.readFileSync(c.tokenFile,"utf8").trim();
let ok=false;
for(let i=0;i<20;i++) { try { const r=await fetch(`http://127.0.0.1:${c.port}/v1/status`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)}); if(r.ok){ok=true;break;} } catch {} await new Promise(resolve=>setTimeout(resolve,1000)); }
if(!ok)throw new Error("Guardian health check failed; inspect private logs before any rollback");
console.log(JSON.stringify({healthy:true,walletAddress:c.walletAddress,tradingMode:c.trading?.mode??"disabled"}));'
"${base[@]}" exec -T guardian node dist/wallet-guardian/cli.js trading-report --directory "$vault"
printf 'Guardian updated to %s, mode %s. Private backup: %s\n' "$revision" "$mode" "$backup"
printf 'Only guardian was restarted. No key or funds were copied to the inference host.\n'
