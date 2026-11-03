#!/bin/sh
# Install the selected fork. For a reviewed installation, set AUTOMATON_REPO
# and a full AUTOMATON_COMMIT before invoking this script from a local file.
set -eu

REPO="${AUTOMATON_REPO:-https://github.com/egatrapeng/automaton.git}"
PIN="${AUTOMATON_COMMIT:-}"

if [ -n "${AUTOMATON_DIR:-}" ]; then
  INSTALL_DIR="$AUTOMATON_DIR"
elif [ -w /opt ] || [ "$(id -u)" = "0" ]; then
  INSTALL_DIR="/opt/automaton"
else
  INSTALL_DIR="$HOME/.automaton/runtime"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js >= 20 is required. Install it first." >&2
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[ERROR] Node.js >= 20 required, found $(node -v)." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "[ERROR] git is required." >&2
  exit 1
fi
# No credentials, query strings or shell syntax may be copied into the source URL.
node -e 'const u=new URL(process.argv[1]); if(u.protocol!=="https:" || u.username || u.password || u.port || u.search || u.hash || !/^\/[A-Za-z0-9._/-]+$/.test(u.pathname) || u.pathname.includes("..")) process.exit(1)' "$REPO" || {
  echo "[ERROR] AUTOMATON_REPO must be a credential-free HTTPS repository URL." >&2
  exit 1
}
if [ -n "$PIN" ]; then
  node -e 'if(!/^[a-f0-9]{40}$/.test(process.argv[1])) process.exit(1)' "$PIN" || {
    echo "[ERROR] AUTOMATON_COMMIT must be a full 40-character commit SHA." >&2
    exit 1
  }
fi

if [ -e "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  CURRENT=$(git rev-parse --verify 'HEAD^{commit}')
  if [ -n "$PIN" ] && [ "$CURRENT" != "$PIN" ]; then
    echo "[ERROR] Existing checkout differs from the requested commit; use the reviewed update workflow. No files were changed." >&2
    exit 1
  fi
  if [ -n "${AUTOMATON_REPO:-}" ]; then
    test "$(git remote get-url origin)" = "$REPO" || {
      echo "[ERROR] Existing checkout has another origin. Refusing to switch repositories." >&2
      exit 1
    }
  fi
  PIN="$CURRENT"
  echo "[INFO] Reusing existing checkout at commit $PIN; no implicit pull or reset."
else
  test ! -e "$INSTALL_DIR" || {
    echo "[ERROR] Installation directory already exists without Git metadata; preserve it and choose another path." >&2
    exit 1
  }
  if [ -z "$PIN" ]; then
    PIN=$(git ls-remote --exit-code "$REPO" refs/heads/main | awk 'NR == 1 { print $1 }')
    node -e 'if(!/^[a-f0-9]{40}$/.test(process.argv[1])) process.exit(1)' "$PIN" || exit 1
    echo "[WARN] No reviewed commit supplied. Resolved main once to $PIN; this verifies identity, not code safety." >&2
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --no-checkout -- "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  git cat-file -e "$PIN^{commit}" 2>/dev/null || git fetch origin "$PIN"
  git checkout --detach "$PIN"
fi

test "$(git rev-parse HEAD)" = "$PIN"
# Pin the package manager without replacing the user's global installation.
TOOLS_DIR="${AUTOMATON_TOOLS_DIR:-$HOME/.local/share/automaton-tools}"
if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version)" != "10.28.1" ]; then
  npm install --prefix "$TOOLS_DIR" --no-audit --no-fund pnpm@10.28.1
  export PATH="$TOOLS_DIR/node_modules/.bin:$PATH"
fi
pnpm install --frozen-lockfile
pnpm run build
node dist/index.js --help
# Build and launch remain available; dependencies may execute the lifecycle
# scripts explicitly permitted by this exact revision's pnpm configuration.
exec node dist/index.js --run
