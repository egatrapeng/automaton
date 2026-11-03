#!/usr/bin/env python3
"""Interactive local credential entry. Never transmit or print the key."""
import datetime
import decimal
import getpass
import json
import os
import pathlib
import tempfile


def main():
    root = pathlib.Path.home() / ".automaton"
    filename = root / "automaton.json"
    if not filename.is_file() or filename.is_symlink():
        raise SystemExit("Run the existing setup first; a regular automaton.json is required.")
    config = json.loads(filename.read_text())
    key = getpass.getpass("Claude API key (hidden, never paste it in chat): ").strip()
    if not key.startswith("sk-ant-"):
        raise SystemExit("Expected an Anthropic API key starting with sk-ant-. Nothing changed.")
    model = input("Claude model ID [claude-sonnet-4-6]: ").strip() or "claude-sonnet-4-6"
    if not model.startswith("claude-") or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for c in model):
        raise SystemExit("Invalid Claude model ID. Nothing changed.")
    budget = decimal.Decimal(input("Estimated daily API budget in USD [1.00]: ").strip() or "1.00")
    if not budget.is_finite() or budget <= 0 or budget * 100 != (budget * 100).to_integral_value():
        raise SystemExit("Expected a positive amount with at most two decimal places. Nothing changed.")
    cents = int(budget * 100)
    # Preserve the existing identity, genesis prompt, wallet and other settings.
    backup = root / "backups" / datetime.datetime.now(datetime.timezone.utc).strftime("claude-%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup.parent, 0o700)
    fd = os.open(backup / "config.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(filename.read_text())
    config.update(runtimeMode="standalone", anthropicApiKey=key, inferenceModel=model, sandboxId="")
    config["execution"] = {**config.get("execution", {}), "mode": "host"}
    config.setdefault("treasuryPolicy", {})["maxInferenceDailyCents"] = cents
    config["modelStrategy"] = {**config.get("modelStrategy", {}), "inferenceModel": model,
        "lowComputeModel": model, "criticalModel": model, "hourlyBudgetCents": cents,
        "sessionBudgetCents": 0, "perCallCeilingCents": min(cents, 20), "maxTokensPerTurn": 2048}
    config["maxTokensPerTurn"] = 2048
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=root, prefix=".claude-config-", delete=False) as output:
            name = output.name
            os.fchmod(output.fileno(), 0o600)
            json.dump(config, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, filename)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)
    print("Claude standalone configuration saved. No API call made; key not displayed.")
    print("Claude API usage is billed separately. Set a spending limit in the Anthropic console too.")
    print("Conway provisioning, recharges and remote colony services are not used in this mode.")


if __name__ == "__main__":
    main()
