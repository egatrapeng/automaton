#!/usr/bin/env python3
"""Enable local trading tools/reports without changing financial authority or secrets."""
import argparse
import json
import os
from pathlib import Path
import secrets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default=str(Path.home() / '.automaton' / 'automaton.json'))
    parser.add_argument('--mode', choices=['on', 'off'], required=True)
    args = parser.parse_args()
    target = Path(args.config).expanduser()
    if target.is_symlink() or not target.is_file():
        raise SystemExit('A regular existing configuration is required.')
    old = target.read_bytes()
    config = json.loads(old)
    if args.mode == 'on' and not config.get('walletGuardian'):
        raise SystemExit('Configure the independent guardian first; no local signer fallback.')
    config['trading'] = {'enabled': args.mode == 'on'}
    stamp = secrets.token_hex(8)
    backup_directory = target.parent / 'backups' / ('trading-config-' + stamp)
    backup_directory.mkdir(parents=True, mode=0o700)
    backup = backup_directory / 'config.json'
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
        out.write(old)
    temporary = target.with_name(target.name + '.new-' + stamp)
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
            json.dump(config, out, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    # State versioning can use a separate Git repository from the application.
    # Its private report/config backups must also stay out of ordinary git add.
    git_directory = target.parent / '.git'
    if git_directory.is_dir() and not git_directory.is_symlink():
        info = git_directory / 'info'
        info.mkdir(exist_ok=True)
        exclude = info / 'exclude'
        if exclude.is_symlink():
            raise SystemExit('Refusing a symlinked Git exclude file; review before restarting.')
        with exclude.open('a') as out:
            out.write('\n# Private Automaton trading data\n/backups/\n/trading-report.json\n/automaton.json\n*.key\n')
    print('Local trading tools/report sync configured. Private backup saved under backups/.')
    print('Restart only automaton. Guardian mode, wallet, models, prompt and budgets preserved.')


if __name__ == '__main__':
    main()
