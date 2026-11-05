# -*- coding: utf-8 -*-
"""Tell Bing (and the other IndexNow engines) which pages changed, so ChatGPT search and Bing pick them up fast."""
import json, os, sys, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.join(HERE, 'indexnow_key')).read().strip()
import re
if os.environ.get('PING_ALL') == 'true':
    urls = re.findall(r'<loc>(https://hazem-store\.com[^<]*)</loc>', open(os.path.join(HERE, '..', '..', 'sitemap.xml'), encoding='utf-8').read()) + ['https://hazem-store.com/llms.txt']
else:
    p = os.environ.get('SEO_CHANGED', '/tmp/seo-changed.txt')
    urls = [u for u in (open(p).read().split() if os.path.exists(p) else []) if u.startswith('https://hazem-store.com')]
if not urls: print('nothing changed'); sys.exit(0)
body = json.dumps({'host': 'hazem-store.com', 'key': KEY, 'keyLocation': f'https://hazem-store.com/{KEY}.txt', 'urlList': urls[:10000]}).encode()
req = urllib.request.Request('https://api.indexnow.org/indexnow', data=body, headers={'Content-Type': 'application/json; charset=utf-8'})
try:
    with urllib.request.urlopen(req, timeout=30) as r: print('IndexNow', r.status, len(urls), 'urls')
except Exception as e: print('IndexNow failed:', e)
