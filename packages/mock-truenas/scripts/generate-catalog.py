#!/usr/bin/env python3
"""
Regenerates src/data/catalog.json for @apexos/mock-truenas from the public TrueNAS apps catalog
(https://github.com/truenas/apps, LGPL-3.0).

Usage:  python3 -I scripts/generate-catalog.py [REF] [--out PATH]

REF defaults to the pinned commit below, so the output is reproducible. For each selected app it reads
  - catalog.json                         (train/app metadata: titles, descriptions, versions, icons, ...)
  - trains/<train>/<app>/app_versions.json (app_metadata and the install schema of the latest version)
  - ix-dev/<train>/<app>/ix_values.yaml    (container image names)
and keeps a trimmed install schema (labels, extra networks and additional storage are dropped to keep
the file small). Only the standard library is used; downloaded data is parsed, never executed.
"""
import datetime
import json
import os
import sys
import urllib.request

REPO = 'truenas/apps'
DEFAULT_REF = 'fca56f2374d13d956d3cd18491609a16d9c02020'

APPS = [
    ('community', 'jellyfin'), ('stable', 'plex'), ('stable', 'emby'), ('community', 'immich'),
    ('stable', 'nextcloud'), ('stable', 'syncthing'), ('stable', 'home-assistant'), ('community', 'qbittorrent'),
    ('community', 'sonarr'), ('community', 'radarr'), ('community', 'prowlarr'), ('community', 'lidarr'),
    ('community', 'bazarr'), ('community', 'seerr'), ('community', 'navidrome'), ('community', 'paperless-ngx'),
    ('community', 'actual-budget'), ('community', 'vaultwarden'), ('stable', 'pihole'), ('community', 'adguard-home'),
    ('community', 'uptime-kuma'), ('community', 'audiobookshelf'), ('stable', 'aistor'), ('community', 'gitea'),
    ('community', 'homepage'), ('community', 'filebrowser'), ('community', 'tailscale'), ('stable', 'photoprism'),
]

KEEP_SCHEMA_KEYS = ('type', 'default', 'required', 'enum', 'min', 'max', 'min_length', 'max_length', 'private',
                    'hidden', 'immutable', 'valid_chars', 'null', 'show_if', 'show_subquestions_if')
METADATA_KEYS = ('name', 'title', 'description', 'app_readme', 'categories', 'home', 'icon_url', 'latest_version',
                 'latest_app_version', 'latest_human_version', 'last_update', 'recommended', 'healthy', 'healthy_error',
                 'maintainers', 'tags', 'screenshots', 'sources', 'capabilities', 'run_as_context')


def fetch(path, ref):
    url = f'https://raw.githubusercontent.com/{REPO}/{ref}/{path}'
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read().decode('utf-8')


def trim_question(q):
    sch = q.get('schema', {})
    out_s = {k: sch[k] for k in KEEP_SCHEMA_KEYS if k in sch}
    for key in ('attrs', 'items', 'subquestions'):
        if key in sch:
            out_s[key] = [trim_question(a) for a in sch[key]]
    out = {'variable': q['variable'], 'label': q.get('label', ''), 'schema': out_s}
    if q.get('description'):
        out['description'] = q['description']
    if q.get('group'):
        out['group'] = q['group']
    return out


def defaults(q):
    sch = q.get('schema', {})
    t = sch.get('type')
    if t == 'dict':
        res = {}
        for a in sch.get('attrs', []) or []:
            v = defaults(a)
            if v is not None:
                res[a['variable']] = v
        return res
    if 'default' in sch:
        return sch['default']
    if t == 'list':
        return []
    return None


def find_ports(questions):
    ports = []
    for q in questions:
        if q['variable'] != 'network':
            continue
        for a in q['schema'].get('attrs', []) or []:
            attrs = {x['variable']: x for x in a['schema'].get('attrs', []) or []}
            pn = attrs.get('port_number')
            if pn is None or 'default' not in pn['schema']:
                continue
            bm = attrs.get('bind_mode')
            ports.append({
                'name': a['variable'],
                'label': a.get('label', a['variable']),
                'port': pn['schema']['default'],
                'bind_mode': (bm['schema'].get('default') if bm else 'published') or '',
                'protocol': 'tcp',
            })
    return ports


def find_storage(questions):
    out = []
    for q in questions:
        if q['variable'] != 'storage':
            continue
        for a in q['schema'].get('attrs', []) or []:
            if a['schema'].get('type') != 'dict':
                continue
            attrs = {x['variable']: x for x in a['schema'].get('attrs', []) or []}
            t = attrs.get('type', {}).get('schema', {}).get('default')
            ds = attrs.get('ix_volume_config', {}).get('schema', {}).get('attrs', [])
            ds_name = next((x['schema'].get('default') for x in ds if x['variable'] == 'dataset_name'), None)
            out.append({'name': a['variable'], 'label': a.get('label', a['variable']), 'type': t, 'dataset_name': ds_name})
    return out


def parse_images(text):
    """Tiny parser for the `images:` block of ix_values.yaml -> {key: 'repo:tag'} (digest stripped)."""
    images, cur, in_images = {}, None, False
    for line in text.splitlines():
        if line.startswith('images:'):
            in_images = True
            continue
        if in_images and line and not line.startswith(' ') and line.strip():
            break
        if not in_images:
            continue
        stripped = line.strip()
        if line.startswith('  ') and not line.startswith('    ') and stripped.endswith(':'):
            cur = stripped[:-1]
            images[cur] = {}
        elif cur and stripped.startswith('repository:'):
            images[cur]['repository'] = stripped.split(':', 1)[1].strip().strip('"')
        elif cur and stripped.startswith('tag:'):
            images[cur]['tag'] = stripped.split(':', 1)[1].strip().strip('"').split('@')[0]
    out = {}
    for k, v in images.items():
        if 'repository' not in v or 'tag' not in v:
            continue
        if any(x in k for x in ('container_utils', 'upgrade', 'cuda', 'rocm', 'openvino', 'intel', 'nvidia')):
            continue
        if k in ('plex_pass_image', 'yq_image'):
            continue
        out[k] = f"{v['repository']}:{v['tag']}"
    pg = sorted(k for k in out if k.startswith('postgres_'))
    for k in pg[:-1]:
        del out[k]  # keep only the newest postgres image
    return out


def build_app(catalog, train, name, ref):
    entry = catalog[train][name]
    versions = json.loads(fetch(f'trains/{train}/{name}/app_versions.json', ref))
    ver = versions.get(entry['latest_version']) or versions[next(iter(versions))]
    questions = ver['schema']['questions']
    item = {k: entry[k] for k in METADATA_KEYS if k in entry}
    item['train'] = train
    item['app_metadata'] = {k: v for k, v in ver['app_metadata'].items() if k != 'lib_version_hash'}
    item['changelog'] = ver.get('changelog')
    item['images'] = parse_images(fetch(f'ix-dev/{train}/{name}/ix_values.yaml', ref))
    item['ports'] = find_ports(questions)
    item['storage'] = find_storage(questions)
    item['default_values'] = {q['variable']: defaults(q) for q in questions}
    item['default_values'].pop('labels', None)
    # Drop generic, very large boilerplate sections to keep the file small.
    trimmed = []
    for q in questions:
        if q['variable'] == 'labels':
            continue
        tq = trim_question(q)
        if 'attrs' in tq['schema']:
            tq['schema']['attrs'] = [a for a in tq['schema']['attrs']
                                     if (q['variable'], a['variable']) not in {('storage', 'additional_storage'), ('network', 'networks')}]
        trimmed.append(tq)
    used_groups = {q.get('group') for q in trimmed}
    item['schema'] = {'groups': [g for g in ver['schema']['groups'] if g['name'] in used_groups], 'questions': trimmed}
    return item


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--out')]
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'data', 'catalog.json')
    for a in sys.argv[1:]:
        if a.startswith('--out='):
            out_path = a.split('=', 1)[1]
    ref = args[0] if args else DEFAULT_REF
    catalog = json.loads(fetch('catalog.json', ref))
    apps = [build_app(catalog, train, name, ref) for train, name in APPS]
    header = {
        'source': f'https://github.com/{REPO}',
        'license': 'LGPL-3.0',
        'commit': ref,
        'generated': datetime.date.today().isoformat(),
        'note': 'Metadata (names, titles, descriptions, versions, categories, icons, screenshots, install schemas) '
                'copied from the truenas/apps catalog. Only a subset of apps is included.',
    }
    with open(out_path, 'w') as f:
        # One compact app per line keeps the file small and diffs readable.
        f.write('{\n')
        for k, v in header.items():
            f.write(f' {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n')
        f.write(' "apps": [\n')
        f.write(',\n'.join('  ' + json.dumps(a, ensure_ascii=False, separators=(',', ':')) for a in apps))
        f.write('\n ]\n}\n')
    print(f'wrote {len(apps)} apps to {out_path}')


if __name__ == '__main__':
    main()
