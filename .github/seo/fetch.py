# -*- coding: utf-8 -*-
"""Pull the public catalogue (products, categories, payment method names, approved reviews) from Firestore
into catalog.json, so the static pages always show today's products and prices. Standard library only."""
import json, os, re, sys, urllib.request, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
cfg = open(os.path.join(REPO, 'config.js'), encoding='utf-8').read()
KEY = re.search(r'apiKey:\s*"([^"]+)"', cfg).group(1)
PROJECT = re.search(r'projectId:\s*"([^"]+)"', cfg).group(1)
BASE = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents'

def fv(v):
    if not isinstance(v, dict): return None
    if 'stringValue' in v: return v['stringValue']
    if 'integerValue' in v: return int(v['integerValue'])
    if 'doubleValue' in v: return v['doubleValue']
    if 'booleanValue' in v: return v['booleanValue']
    if 'nullValue' in v: return None
    if 'timestampValue' in v: return v['timestampValue']
    if 'arrayValue' in v: return [fv(x) for x in v['arrayValue'].get('values', [])]
    if 'mapValue' in v: return {k: fv(x) for k, x in v['mapValue'].get('fields', {}).items()}
    return None

def get(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)

def doc(d): return dict(fv({'mapValue': d}) or {}, id=d['name'].rsplit('/', 1)[1])

products, tok = [], ''
while True:
    r = get(f'{BASE}/products?pageSize=300&key={KEY}' + (f'&pageToken={tok}' if tok else ''))
    products += [doc(d) for d in r.get('documents', [])]
    tok = r.get('nextPageToken')
    if not tok: break
settings = doc(get(f'{BASE}/settings/main?key={KEY}'))
rq = {'structuredQuery': {'from': [{'collectionId': 'reviews'}], 'where': {'fieldFilter': {'field': {'fieldPath': 'status'}, 'op': 'EQUAL', 'value': {'stringValue': 'approved'}}}, 'limit': 500}}
reviews = [doc(x['document']) for x in get(f'{BASE}:runQuery?key={KEY}', rq) if 'document' in x]

KEEP_P = ('id', 'name', 'cat', 'desc', 'features', 'keywords', 'note', 'domain', 'active', 'soldOut', 'sort', 'acct', 'badge')
KEEP_PL = ('id', 'name', 'price', 'compare', 'war', 'out', 'instant', 'acct')
def first_name(n): return (str(n or '').strip().split() or [''])[0][:30]
out = {
    'fetchedAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
    'storeName': settings.get('storeName') or 'حازم ستور',
    'cats': [{'id': c.get('id'), 'name': c.get('name')} for c in (settings.get('categories') or [])],
    'payments': [{'name': m.get('name'), 'auto': bool(m.get('auto'))} for m in (settings.get('payments') or []) if m.get('active') is not False and m.get('name')],
    'products': sorted([dict({k: p.get(k) for k in KEEP_P if p.get(k) is not None}, plans=[{k: pl.get(k) for k in KEEP_PL if pl.get(k) is not None} for pl in (p.get('plans') or [])]) for p in products], key=lambda p: (p.get('sort') or 0, p['id'])),
    'reviews': sorted([{'name': first_name(r.get('name')), 'rating': r.get('rating') or 5, 'text': (r.get('text') or '')[:400], 'product': r.get('product') or '', 'at': str(r.get('createdAt') or '')[:10]} for r in reviews], key=lambda r: r['at'], reverse=True),
}
path = os.path.join(HERE, 'catalog.json')
old = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
same = {k: v for k, v in old.items() if k != 'fetchedAt'} == {k: v for k, v in out.items() if k != 'fetchedAt'}
if not same: json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('products', len(out['products']), 'reviews', len(out['reviews']), 'unchanged' if same else 'updated')
