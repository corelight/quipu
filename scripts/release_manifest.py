"""Validate the seven unsigned release packages and record their build origin."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def package_names(version):
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Expected stable major.minor.patch version')
    return {
        f'Quipu-{version}-1.x86_64.rpm', f'Quipu_{version}_amd64.AppImage',
        f'Quipu_{version}_amd64.deb', f'Quipu_{version}_x64-setup.exe',
        f'Quipu_{version}_x64-setup-offline.exe',
        f'Quipu_{version}_x64_en-US.msi', f'Quipu_{version}_x64_en-US-offline.msi',
    }


def checksums(directory, version):
    expected = package_names(version)
    actual = {p.name for p in directory.iterdir()} - {'SHA256SUMS'}
    if actual != expected:
        raise ValueError(f'Unexpected package set: missing={expected-actual}, extra={actual-expected}')
    result = {}
    for name in sorted(expected):
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Invalid package: {name}')
        with path.open('rb') as stream:
            result[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return result


def main():
    directory = Path(sys.argv[1])
    version = json.loads(Path('app/package.json').read_text())['version']
    ref = os.environ['GITHUB_REF']
    if ref.startswith('refs/tags/') and ref != f'refs/tags/v{version}':
        raise ValueError('Tag does not match package version')
    hashes = checksums(directory, version)
    record = dict(repository=os.environ['GITHUB_REPOSITORY'],
                  source_sha=os.environ['GITHUB_SHA'], version=version,
                  release_run_id=int(os.environ['GITHUB_RUN_ID']),
                  release_run_attempt=int(os.environ['GITHUB_RUN_ATTEMPT']),
                  packages=hashes)
    (directory / 'RELEASE_BUILD.json').write_text(json.dumps(record, indent=2) + '\n')
    (directory / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name, digest in hashes.items()))


if __name__ == '__main__':
    main()
