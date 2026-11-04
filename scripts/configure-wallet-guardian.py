#!/usr/bin/env python3
"""Connect an existing runtime to an independent signer; never load a wallet key."""
import datetime
import getpass
import json
import os
import pathlib
import re
import tempfile
import urllib.parse


def main():
    root = pathlib.Path.home() / ".automaton"
    filename = root / "automaton.json"
    if not filename.is_file() or filename.is_symlink():
        raise SystemExit("An existing regular automaton.json is required. Nothing changed.")
    config = json.loads(filename.read_text())
    print("The funded signer must run on a separate trusted host, outside this agent's administration.")
    print("Use its NEW wallet, never the existing VPS identity wallet. No payments are made here.")
    origin = input("Independent guardian HTTPS origin: ").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise SystemExit("Expected an HTTPS origin without path or embedded credentials. Nothing changed.")
    wallet = input("New guardian funding wallet address (0x...): ").strip()
    owner = input("Initially configured owner/MetaMask address (0x...): ").strip()
    for address in [wallet, owner]:
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address) or int(address[2:], 16) == 0:
            raise SystemExit("Invalid address. Nothing changed.")
    if wallet.lower() == str(config.get("walletAddress", "")).lower() or wallet.lower() == owner.lower():
        raise SystemExit("The new funding wallet must differ from both the VPS identity and the owner wallet. Nothing changed.")
    treasury = config.get("treasuryPolicy", {})
    current_cap = treasury.get("maxX402PaymentCents", 100)
    raw_cap = input(f"Local maximum per service payment in USDC cents [{current_cap}; 0 disables payments]: ").strip()
    cap = int(raw_cap) if raw_cap else current_cap
    if not isinstance(cap, int) or isinstance(cap, bool) or cap < 0 or cap > 9007199254740991:
        raise SystemExit("Expected non-negative integer cents. Nothing changed.")
    token = getpass.getpass("Guardian CLIENT token (hidden; never the private wallet key): ").strip()
    if len(token) < 32 or len(token) > 512 or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
        raise SystemExit("Invalid client token. Nothing changed.")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backups = root / "backups"
    backups.mkdir(mode=0o700, exist_ok=True)
    os.chmod(backups, 0o700)
    with os.fdopen(os.open(backups / f"guardian-{stamp}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        output.write(filename.read_text())
        output.flush()
        os.fsync(output.fileno())
    # A new token filename avoids leaving the previous config paired with a
    # changed token if replacing the config is interrupted.
    token_file = root / f"guardian-client-{stamp}.key"
    with os.fdopen(os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        output.write(token)
        output.flush()
        os.fsync(output.fileno())
    config["walletGuardian"] = {"baseUrl": origin, "tokenFile": str(token_file), "walletAddress": wallet, "ownerAddress": owner}
    config.setdefault("treasuryPolicy", {})["maxX402PaymentCents"] = cap
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=root, prefix=".guardian-config-", delete=False) as output:
            temporary = output.name
            os.fchmod(output.fileno(), 0o600)
            json.dump(config, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, filename)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    print("Guardian connection saved. No funds moved; no existing spending limit was raised by default.")
    print("Restart the runtime to verify pinned wallet identities. No local signing fallback is allowed.")
    print("Local notifications: wallet-guardian-notifications.jsonl beside state.db.")


if __name__ == "__main__":
    main()
