#!/usr/bin/env python3
"""Install only reviewed local adaptations. No remote code, signing, or config reset."""
import argparse
import hashlib
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default=str(Path.home() / '.automaton' / 'skills'))
    args = parser.parse_args()
    source = Path(__file__).resolve().parent.parent / 'skills'
    destination = Path(args.directory).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ['trading-uniswap-v1', 'trading-bankr-research', 'trading-agentkit-observer', 'trading-continuous-study']:
        data = (source / name / 'SKILL.md').read_bytes()
        folder = destination / name
        if folder.is_symlink():
            raise SystemExit('Refusing a symlinked skill directory: ' + name)
        folder.mkdir(mode=0o700, exist_ok=True)
        target = folder / 'SKILL.md'
        if target.is_symlink():
            raise SystemExit('Refusing a symlinked skill file: ' + name)
        if target.exists() and target.read_bytes() != data:
            raise SystemExit('Existing skill differs; review before replacing: ' + name)
        if not target.exists():
            with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
                output.write(data)
        print(name + ': ' + hashlib.sha256(data).hexdigest())
    print('Four local skill adaptations installed. Existing skills and financial settings preserved.')


if __name__ == '__main__':
    main()
