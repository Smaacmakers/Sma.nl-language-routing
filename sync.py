#!/usr/bin/env python3
"""Read-only by default. --publish writes one validated snapshot to Cloudflare KV."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ORIGIN = 'https://www.smaac.nl'
SITEMAP = ORIGIN + '/sitemap.xml'
S = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
X = '{http://www.w3.org/1999/xhtml}'
LANGS = {'nl-NL': 'nl', 'en-GB': 'en', 'x-default': 'default'}

def path_of(value):
    u = urlsplit(value)
    if u.scheme != 'https' or u.netloc != 'www.smaac.nl' or u.query or u.fragment or '\\' in u.path:
        raise ValueError('Unexpected sitemap URL: ' + value)
    return u.path.rstrip('/') or '/'

def get(value):
    path_of(value)
    with urlopen(Request(value, headers={'User-Agent': 'Smaac-route-sync/1.0'}), timeout=30) as res:
        path_of(res.url)
        if res.status != 200:
            raise ValueError('Sitemap fetch failed')
        data = res.read(5_000_001)
        if len(data) > 5_000_000:
            raise ValueError('Sitemap larger than configured limit')
        return data

def load(data, seen=None):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DTD/entity declarations are not allowed')
    root = ET.fromstring(data)
    if root.tag == S + 'sitemapindex':
        seen = set() if seen is None else seen
        entries = []
        for node in root.findall(S + 'sitemap'):
            url = node.findtext(S + 'loc')
            if url in seen or len(seen) >= 20:
                raise ValueError('Repeated or excessive child sitemap')
            seen.add(url)
            entries.extend(load(get(url), seen))
        return entries
    if root.tag != S + 'urlset':
        raise ValueError('Not a supported sitemap')
    entries = []
    for node in root.findall(S + 'url'):
        loc = path_of(node.findtext(S + 'loc'))
        group = {}
        for link in node.findall(X + 'link'):
            if link.get('rel') != 'alternate':
                continue
            tag = link.get('hreflang')
            if tag not in LANGS:
                raise ValueError('New locale requires configuration: ' + str(tag))
            lang = LANGS[tag]
            path = path_of(link.get('href'))
            if lang in group and group[lang] != path:
                raise ValueError('Ambiguous hreflang for ' + loc)
            group[lang] = path
        entries.append((loc, group))
    return entries

def compile_routes(entries):
    records = {}
    missing_alternates = []
    for loc, supplied in entries:
        group = dict(supplied)
        lang = loc.split('/')[1]
        if lang not in ('nl', 'en'):
            raise ValueError('Unexpected primary locale without prefix: ' + loc)
        if not group:
            # A locale-only page is still a known destination. Never fabricate
            # its absent translation just because a similar slug exists.
            group = {lang: loc}
            missing_alternates.append(loc)
        if group.get(lang) != loc:
            raise ValueError('Missing self-reference: ' + loc)
        for key, path in group.items():
            if key in ('nl', 'en') and not (path == '/' + key or path.startswith('/' + key + '/')):
                raise ValueError('Hreflang/prefix mismatch: ' + path)
        if group.get('default') and group['default'] not in [group.get('nl'), group.get('en')]:
            raise ValueError('Unexpected x-default destination: ' + loc)
        if loc in records and records[loc] != group:
            raise ValueError('Conflicting duplicate loc: ' + loc)
        records[loc] = group
    for loc, group in records.items():
        for target in group.values():
            if records.get(target) != group:
                raise ValueError('Missing/nonreciprocal alternate: ' + loc + ' -> ' + target)
    groups, aliases, localized, ids = [], {}, {}, {}
    for loc, group in sorted(records.items()):
        signature = json.dumps(group, sort_keys=True)
        if signature not in ids:
            ids[signature] = len(groups)
            groups.append(group)
        i = ids[signature]
        localized[loc] = i
        alias = loc[3:] or '/'
        if alias.startswith(('/nl/', '/en/')) or alias in ('/nl', '/en'):
            raise ValueError('Neutral alias overlaps explicit locale: ' + alias)
        if alias in aliases and aliases[alias] != i:
            raise ValueError('Ambiguous neutral alias: ' + alias)
        aliases[alias] = i
    if '/' not in aliases or len(records) < 2:
        raise ValueError('Incomplete sitemap (homepage missing)')
    payload = {'schema': 1, 'source': SITEMAP, 'groups': groups, 'aliases': aliases, 'localized': localized}
    payload['digest'] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    payload['generatedAt'] = datetime.now(timezone.utc).isoformat()
    payload['stats'] = {'urls': len(records), 'groups': len(groups), 'aliases': len(aliases),
                        'pairedGroups': sum('nl' in g and 'en' in g for g in groups),
                        'withoutSitemapAlternates': sorted(set(missing_alternates))}
    return payload

def publish(payload):
    account = os.environ['CF_ACCOUNT_ID']
    namespace = os.environ['CF_KV_NAMESPACE_ID']
    token = os.environ['CF_API_TOKEN']
    endpoint = f'https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{namespace}/values/routes%3Acurrent'
    body = json.dumps(payload, separators=(',', ':')).encode()
    req = Request(endpoint, data=body, method='PUT', headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream'})
    with urlopen(req, timeout=30) as res:
        result = json.load(res)
    if not result.get('success'):
        raise RuntimeError('Cloudflare refused snapshot update')

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, help='Use a saved sitemap instead of fetching it')
    p.add_argument('--output', type=Path, default=Path('routes.json'))
    p.add_argument('--publish', action='store_true')
    args = p.parse_args()
    payload = compile_routes(load(args.input.read_bytes() if args.input else get(SITEMAP)))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    with args.output.with_suffix('.csv').open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['neutral_alias', 'nl', 'en', 'fallback'])
        for alias, i in sorted(payload['aliases'].items()):
            group = payload['groups'][i]
            writer.writerow([alias, group.get('nl', ''), group.get('en', ''), group.get('default') or group.get('en') or group.get('nl')])
    if args.publish:
        publish(payload)
    print(json.dumps({**payload['stats'], 'digest': payload['digest'], 'published': args.publish}, indent=2))

if __name__ == '__main__':
    main()
