# Independent guardian Docker image

Build from the repository root on the trusted signer host:

```sh
docker build -f deploy/wallet-guardian/Dockerfile -t local/wallet-guardian:ab003e9 .
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --cpus 0.5 --pids-limit 64 local/wallet-guardian:ab003e9 help
```

The Node base image is pinned by digest. Dependency versions come from the frozen
pnpm lockfile. Build tools remain in the build stage; the final process runs as
the unprivileged `node` user. The Dockerfile-specific ignore file excludes Git,
local dependencies, wallet files, client keys, databases and local configuration.
The build requires more memory than the service: TypeScript has a 768 MiB heap
limit. Do not describe that limit as a bound on the whole build process tree.

These commands only build an image and print CLI help: no public port, wallet,
volume or long-running service is created. Existing Docker projects are untouched.
Do not run global prune, daemon restarts or unrelated Compose commands.

Validation on 2026-11-04: image built successfully; CLI help, initialization of
an empty test wallet and SQLite-backed status succeeded as the non-root image
user with network disabled, a read-only root filesystem, 512 MiB and 0.5 CPU.
The dedicated test volume was removed afterwards. No production wallet, payment,
Hostinger deployment or TLS endpoint was used in this validation.

An independent private volume, initial owner configuration, HTTPS on a free port,
certificate renewal and network controls still need deployment configuration.
The guardian listens on container loopback; publishing port 8787 alone will not
make it reachable through a separate proxy container. Never use host networking
or mount the Docker socket as a shortcut. See the [wallet guide](../../docs/WALLET_GUARDIAN.md).

For builds in the managed Codex environment only, preserve the provided proxy
settings and add `--secret id=proxy_ca,src="$CODEX_PROXY_CERT"`. The optional CA
mount extends Node's trust during dependency installation, is not copied into
the image and never disables certificate checks. A normal Hostinger build does
not require this session-specific CA.
