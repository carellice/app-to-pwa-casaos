#!/usr/bin/env python3
"""Creates the PWA folder from assets/template, filling the placeholders.

    python scaffold.py --target <repo>/PWA --config config.json [--force]

config.json holds every placeholder without underscores, for example:
{
  "APP_ID": "money", "APP_NAME": "Money", "REPO": "owner/repo", "BRANCH": "main", "PWA_DIR": "PWA",
  "DEFAULT_PORT": "8095", "DEVELOPER": "owner", "CASAOS_CATEGORY": "Finance", "LANG": "it",
  "NATIVE_PLATFORM": "Android", "FONT_FILE": "font.ttf", "BG_LIGHT": "#F6F1EA", "BG_DARK": "#15121F",
  "TAGLINE_IT": "...", "TAGLINE_EN": "...", "DESCRIPTION_IT": "...", "DESCRIPTION_EN": "...",
  "VOLUME_DESC_IT": "Database e foto", "VOLUME_DESC_EN": "Database and photos",
  "SHORTCUT_NAME": "Nuovo elemento", "SHORTCUT_ROUTE": "edit"
}
Existing files are never overwritten unless --force is given. At the end it lists the TODO(port)
markers left to fill in, and any placeholder that had no value.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / 'assets' / 'template'
PLACEHOLDER = re.compile(r'__([A-Z][A-Z0-9_]*[A-Z0-9])__')
# Filled at build time by the Vite plugin, not by this script.
BUILD_TIME = {'BUILD', 'FILES'}
# Texts that land inside double quotes in the compose YAML (written by an unquoted bash heredoc),
# in index.html attributes and in the manifest JSON: no character there may close the quotes or
# be expanded by bash.
QUOTED_TEXT = {'APP_NAME', 'DEVELOPER', 'CASAOS_CATEGORY', 'TAGLINE_IT', 'TAGLINE_EN',
               'DESCRIPTION_IT', 'DESCRIPTION_EN', 'VOLUME_DESC_IT', 'VOLUME_DESC_EN'}
UNSAFE_TEXT = re.compile(r'["\\$`\n\r]')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()

    values = json.loads(Path(args.config).read_text(encoding='utf-8'))
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,30}', values.get('APP_ID', '')):
        print('APP_ID must be lowercase letters, digits or "-" (it names the container, the image and the update command).')
        return 1
    unsafe = [key for key in sorted(QUOTED_TEXT) if UNSAFE_TEXT.search(str(values.get(key, '')))]
    if unsafe:
        print('These values must not contain double quotes, backslashes, "$", backticks or newlines '
              '(they go inside quoted YAML, HTML and JSON written by bash): ' + ', '.join(unsafe))
        return 1
    target = Path(args.target)
    missing: set[str] = set()
    written, skipped = [], []

    def fill(text: str) -> str:
        def sub(match: re.Match) -> str:
            key = match.group(1)
            if key in BUILD_TIME:
                return match.group(0)
            if key in values:
                return str(values[key])
            missing.add(key)
            return match.group(0)
        return PLACEHOLDER.sub(sub, text)

    for source in sorted(TEMPLATE.rglob('*')):
        if source.is_dir():
            continue
        relative = Path(fill(str(source.relative_to(TEMPLATE))))
        destination = target / relative
        if destination.exists() and not args.force:
            skipped.append(str(relative))
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            text = source.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            shutil.copyfile(source, destination)
        else:
            # LF everywhere: the shell scripts and the Dockerfile run on Linux.
            destination.write_text(fill(text), encoding='utf-8', newline='\n')
        written.append(str(relative))

    print(f'Written {len(written)} files into {target}')
    if skipped:
        print('Kept existing (use --force to overwrite): ' + ', '.join(skipped))
    if missing:
        print('Placeholders without a value: ' + ', '.join(sorted(missing)))
    todos = []
    for path in target.rglob('*'):
        if path.is_file() and 'node_modules' not in path.parts:
            try:
                for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                    if 'TODO(port)' in line:
                        todos.append(f'{path.relative_to(target)}:{number}: {line.strip()}')
            except UnicodeDecodeError:
                pass
    if todos:
        print('\nTODO(port) left to fill in:')
        print('\n'.join(todos))
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
