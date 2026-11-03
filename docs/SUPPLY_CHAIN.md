# Reproducible installs, autonomous updates and recovery

Installation, package management, self-updates and replication remain available.
These controls establish which code is selected and preserve recovery data; they
do not establish that third-party code is harmless.

## Installer

Download and inspect the installer before executing it. For a reviewed source:

```sh
AUTOMATON_REPO=https://github.com/egatrapeng/automaton.git \
AUTOMATON_COMMIT=<full-reviewed-40-character-commit> \
AUTOMATON_DIR=/opt/automaton sh ./scripts/automaton.sh
```

The installer accepts credential-free HTTPS repository URLs. For a new install
without a commit, it resolves the selected repository's `main` once, displays a
warning, and checks out that exact commit. A resolved commit is not a security
review. Existing checkouts retain their current commit and local changes; running
the installer again never performs an implicit pull or reset. A conflicting
explicit origin/commit is an error. Use the update workflow for actual changes.

Node.js >=20 must already be installed. pnpm 10.28.1 is installed separately when
necessary, dependency installation uses the frozen lockfile, and the runtime is
built and smoke-checked before launch. The installer still launches the agent;
only run it when you intend to start the connected runtime.

## Autonomous updates

`review_upstream_changes` obtains the exact commits and full diffs from the current
fork. `prepareReviewedUpdate` binds application to the same repository origin,
base HEAD and diff, with a 30-minute lifetime. It supports a reviewed individual
commit or the reviewed full target; it does not fetch a newer moving branch
during application. A receipt is consumed by an attempted update.

The working tree must be clean for an ordinary update. The command creates a
`refs/automaton/rollback/...` ref before cherry-picking or fast-forwarding. Builds
use `pnpm install --frozen-lockfile` and the repository's build script.

This review receipt is an integrity binding, not proof of human approval and not
a guarantee that the model correctly understood a diff. Mandatory human approval
for every self-update was not imposed because it conflicts with the requested
autonomous operation. Operators needing that stronger trust boundary must keep
deployment control outside the runtime. A runtime that can edit its own source
cannot make its own application-level checks immutable.

## Recovery

Recovery uses a separate full HEAD-to-target preview, including the removal of
local-only commits. The request must specify the full reviewed target SHA. Before
changing files it creates both:

- A Git backup ref retaining the original commit history.
- A private sibling directory containing `checkout.tar`, including modified,
  untracked and ignored files (dependencies included), excluding only `.git`.

Only after successful archive creation and a readability check does the command
reset to the fixed target. It never executes `git clean`. Do not run concurrent
editing tools during recovery. The archive may be large and contain secrets;
keep its permissions private, retain it until recovery is verified, and do not
upload it. A failed archive stops the reset.

If build validation fails, the previous ref and archive remain available. No
automatic reset is performed after a build failure, because that could discard
intervening work. Stop the runtime, preserve the current failed checkout, inspect
the backup ref with `git show <backup-ref>`, and restore to a separate directory
before manually switching the installation. This also avoids accidentally
restoring a compromised dependency tree into an active process.

## Child replication

Children use the selected parent's sanitized origin and full local **committed**
HEAD. Embedded credentials are never copied. Genesis metadata and the modification
audit include that source identity. Replication refuses tracked working-tree or
index changes before provisioning: review and commit the intended runtime (or
preserve/revert changes yourself) to obtain a consistent snapshot. The code never
pushes or resets changes automatically. Untracked and ignored files are not
replicated. This condition prevents a child silently receiving an older,
unpatched HEAD while the parent runs uncommitted fixes; normal committed
self-modifications remain replicable.
The selected commit must be available from the origin. Local-only unpublished
commits fail explicitly during child provisioning rather than silently falling
back to another fork or a branch tip.

Child tools are installed under `/opt/automaton-tools`, with Node.js 22.23.4 and
pnpm 10.28.1. Child dependency installation uses the selected revision's frozen
lockfile and allowed build scripts. Existing child checkout data is only reused
when its origin, commit and clean state match; mismatches are not erased. Setup
exit codes are checked before advancing to runtime-ready.

Actual child provisioning requires authorized Conway infrastructure and was not
performed by the local tests. Registry/bootstrap downloads and native dependency
scripts remain a trust boundary, even when revisions and checksums are pinned.

## Installing packages

`installNpmPackage` supports registry names and exact versions/tags. It resolves
one exact version plus integrity digest, downloads with `npm pack --ignore-scripts`,
checks both the reported integrity and the actual archive checksum, then installs
that same archive. Local paths, executable options and Git specs are rejected.
Provenance is recorded only after successful installation.

Lifecycle scripts remain enabled by default because native tools often require
them. Their execution is explicitly recorded as third-party code in the audit.
An operator may pass `{allowLifecycleScripts: false}` for packages that work
without them. This is deliberately not a claim that arbitrary package installs
are safe: install them inside the agent's execution boundary, with no access to
the host's secrets or unrestricted privileges. Pinning and checksums establish
artifact identity, not good intent.
