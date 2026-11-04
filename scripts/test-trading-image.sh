#!/usr/bin/env bash
# Disposable unfunded fixture. No public ports, no network, no production volume.
set -euo pipefail
image=${1:?Pass the freshly built guardian image}
fixture="automaton-trading-smoke-$$-$(date +%s)"
volume="$fixture-state"
archive=$(mktemp /tmp/automaton-trading-smoke.XXXXXX.tar.gz)
cleanup() {
  docker rm --force "$fixture" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -f -- "$archive"
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
run=(docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --volume "$volume:/var/lib/guardian-state" "$image")
"${run[@]}" init --directory /var/lib/guardian-state/vault --owner 0x1111111111111111111111111111111111111111 >/dev/null
"${run[@]}" init-observer --directory /var/lib/guardian-state/vault
docker run --detach --name "$fixture" --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
  --volume "$volume:/var/lib/guardian-state" "$image" serve --directory /var/lib/guardian-state/vault >/dev/null
docker exec "$fixture" node --input-type=module -e '
import fs from "node:fs"; import assert from "node:assert/strict";
const c=JSON.parse(fs.readFileSync("/var/lib/guardian-state/vault/guardian-policy.json","utf8"));
const observer=fs.readFileSync(c.observerTokenFile,"utf8").trim();
const url=`http://127.0.0.1:${c.port}`;
let ready=false;
for(let i=0;i<20;i++){try{if((await fetch(url+"/v1/status",{signal:AbortSignal.timeout(1000)})).status===401){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
assert(ready,"server did not start");
const headers={Authorization:`Bearer ${observer}`,"Content-Type":"application/json"};
assert.equal((await fetch(url+"/v1/status",{headers})).status,200);
const report=await fetch(url+"/v1/trading",{headers}); assert.equal(report.status,200); assert.equal((await report.json()).mode,"disabled");
const page=await fetch(url+"/v1/trading/view",{headers}); assert.equal(page.status,200); assert.match(await page.text(),/Trading Automaton/);
assert.equal((await fetch(url+"/v1/trading/tick",{method:"POST",headers,body:"{}"})).status,403);
console.log(JSON.stringify({ok:true,compiledServer:true,privateSqlite:true,observerReadOnly:true,signing:false,network:"none"}));'
docker stop --time 15 "$fixture" >/dev/null
docker rm "$fixture" >/dev/null
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --volume "$volume:/var/lib/guardian-state:ro" --entrypoint tar "$image" -C /var/lib/guardian-state -czf - vault > "$archive"
gzip -t "$archive"
"${run[@]}" trading-configure --directory /var/lib/guardian-state/vault --mode paper
"${run[@]}" trading-report --directory /var/lib/guardian-state/vault
printf 'Disposable Docker smoke test passed. No external request or funded wallet used.\n'
