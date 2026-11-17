# -*- coding: utf-8 -*-
"""Pictures for the Telegram bot: one for the store (home), one when an order is delivered (done), one
per product, and for «المنتجات»: the sections (shop) and one per section (cat-<id>), published under /bot/ on the
site (hazem-store.com/bot/<id>.jpg).

  python3 .github/bot/banners.py <repo> --check   → prints render=1 if any picture is missing or out of date
  python3 .github/bot/banners.py <repo>           → draws what changed (needs Playwright + Chromium)
  python3 .github/bot/banners.py <repo> --local   → same, from .github/seo/catalog.json (no network, no logos)

bot/banners.json lists every picture with a short hash of what is drawn on it; the bot adds that hash to the
picture's address, so Telegram fetches a new picture only when it changed. Prices are not drawn (they change
more often than this runs); the bot writes them under the picture."""
import base64, hashlib, html, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'bot')
CHECK, LOCAL = '--check' in sys.argv, '--local' in sys.argv
STYLE = 4  # bump to redraw everything after changing the design below

# ---------------------------------------------------------------- data
def fv(v):
    if not isinstance(v, dict): return None
    for k in ('stringValue', 'booleanValue', 'doubleValue', 'timestampValue'):
        if k in v: return v[k]
    if 'integerValue' in v: return int(v['integerValue'])
    if 'arrayValue' in v: return [fv(x) for x in v['arrayValue'].get('values', [])]
    if 'mapValue' in v: return {k: fv(x) for k, x in v['mapValue'].get('fields', {}).items()}
    return None

def load():
    if LOCAL:
        c = json.load(open(os.path.join(REPO, '.github/seo/catalog.json'), encoding='utf-8'))
        return c['products'], {'categories': c.get('cats') or [], 'storeName': c.get('storeName')}
    cfg = open(os.path.join(REPO, 'config.js'), encoding='utf-8').read()
    key = re.search(r'apiKey:\s*"([^"]+)"', cfg).group(1)
    base = 'https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents' % re.search(r'projectId:\s*"([^"]+)"', cfg).group(1)
    get = lambda u: json.load(urllib.request.urlopen(u, timeout=30))
    doc = lambda d: dict(fv({'mapValue': d}) or {}, id=d['name'].rsplit('/', 1)[1])
    products, tok = [], ''
    while True:
        r = get(f'{base}/products?pageSize=300&key={key}' + (f'&pageToken={tok}' if tok else ''))
        products += [doc(d) for d in r.get('documents', [])]
        tok = r.get('nextPageToken')
        if not tok: break
    return products, doc(get(f'{base}/settings/main?key={key}'))

def sold(p):  # what the bot shows: not "site only", active, with a price
    return p.get('where') != 'site' and p.get('active') is not False and any((pl or {}).get('price', 0) and float(pl['price']) > 0 for pl in (p.get('plans') or []))

# ---------------------------------------------------------------- colours: the brand's, else one from the name
BRAND = [
    (r'chatgpt|openai', '#052a22', '#10a37f'), (r'claude|anthropic', '#4a1d0e', '#d97757'), (r'grok|x\.ai', '#050505', '#3d3d48'),
    (r'gemini', '#14247a', '#8e5bd8'), (r'canva', '#0a6f8a', '#7d2ae8'), (r'capcut', '#060606', '#1f8a8a'), (r'autodesk', '#07090d', '#1d4f91'),
    (r'duolingo', '#245c00', '#58cc02'), (r'office|microsoft', '#7a1d07', '#e8692e'), (r'telegram|تيليجرام|تلغرام', '#0b4a80', '#2aa3e3'),
    (r'facebook|meta|فيسبوك', '#08306e', '#1877f2'), (r'(^|\W)x(\W|$)|twitter|تويتر', '#000000', '#33363d'), (r'wispr', '#1d1240', '#6d4ce0'),
    (r'muse', '#33082f', '#b0368f'), (r'adobe', '#5c0606', '#eb1000'), (r'miro', '#050038', '#4262ff'), (r'notion', '#0d0d0d', '#4a4a4a'),
    (r'ilovepdf|pdf', '#6b0f0f', '#e5322d'), (r'jetbrains', '#2c1170', '#ff2d7a'), (r'instagram|انستغرام|انستجرام|إنستغرام', '#5b2a86', '#e1306c'),
    (r'shahid|شاهد', '#062e27', '#14a37c'), (r'snap|سناب', '#1a1a1a', '#c9a800'), (r'esim|شرائح|شريحة|انترنت|إنترنت', '#0b3a66', '#1f8bd6'),
    (r'netflix|نتفلكس', '#2a0000', '#e50914'), (r'spotify|سبوتيفاي', '#06301a', '#1db954'), (r'youtube|يوتيوب', '#3d0000', '#ff0000'),
]
def colours(p):
    hay = ' '.join(str(p.get(k) or '') for k in ('id', 'name', 'domain')).lower()
    for rx, a, b in BRAND:
        if re.search(rx, hay): return a, b
    h = int(hashlib.md5(p['id'].encode()).hexdigest()[:6], 16) % 360
    return f'hsl({h},55%,16%)', f'hsl({(h + 25) % 360},70%,46%)'

# ---------------------------------------------------------------- the logo: the one Hazem uploaded, else the site's icon, else a letter
LOGOS = {}
def logo(p):
    if p['id'] not in LOGOS: LOGOS[p['id']] = _logo(p)
    return LOGOS[p['id']]

def _logo(p):
    loc = os.environ.get('BAN_LOGOS')   # tests: lg-<first part of the id>.png
    if LOCAL and loc:
        for k in (p['id'], p['id'].rsplit('-', 1)[0]):
            f = os.path.join(loc, f'lg-{k}.png')
            if os.path.exists(f): return 'data:image/png;base64,' + base64.b64encode(open(f, 'rb').read()).decode()
    img = str(p.get('img') or '')
    if img.startswith('data:image/'): return img
    d = re.sub(r'^https?://|[/?#].*$', '', str(p.get('domain') or '').strip().lower())
    if d and not LOCAL:
        try:
            raw = urllib.request.urlopen(f'https://www.google.com/s2/favicons?domain={d}&sz=256', timeout=20).read()
            if len(raw) > 600: return 'data:image/png;base64,' + base64.b64encode(raw).decode()
        except Exception as e: print('icon', d, e, file=sys.stderr)
    return ''

def cat_name(settings, p):
    for c in settings.get('categories') or []:
        if c.get('id') == p.get('cat'): return str(c.get('name') or '')
    return ''

def pills(p, settings):
    out = []
    plans = [pl for pl in (p.get('plans') or []) if pl and float(pl.get('price') or 0) > 0]
    if plans and all((pl.get('acct') or p.get('acct')) == 'login' for pl in plans): out.append(('mail', 'على إيميلك الشخصي'))
    out.append(('bolt', 'تسليم فوري' if any(pl.get('instant') for pl in plans) else 'تسليم سريع'))
    out.append(('card', 'دفع محلي بالشيكل'))
    return out[:3]

# ---------------------------------------------------------------- drawing
FONT = 'data:font/ttf;base64,' + base64.b64encode(open(os.path.join(HERE, 'Alexandria.ttf'), 'rb').read()).decode()
STORE_LOGO = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(REPO, 'logo.png'), 'rb').read()).decode()
ICON = {
    'grid': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    'mail': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    'bolt': '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    'gift': '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    'card': '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
}
def ico(n, s=30): return f'<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">{ICON[n]}</svg>'

CSS = """@font-face{font-family:A;src:url(%s);font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}body{width:1280px;height:640px;overflow:hidden;font-family:A,sans-serif}
#b{position:relative;width:1280px;height:640px;overflow:hidden;color:#fff;direction:rtl}
.bg{position:absolute;inset:0}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.07) 2px,transparent 2px),linear-gradient(90deg,rgba(255,255,255,.07) 2px,transparent 2px);background-size:64px 64px;-webkit-mask-image:linear-gradient(200deg,#000 10%%,transparent 75%%)}
.glow{position:absolute;border-radius:50%%;filter:blur(10px)}
.streak{position:absolute;top:-200px;left:330px;width:180px;height:1100px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.10),transparent);transform:rotate(28deg)}
.tile{position:absolute;top:96px;right:96px;width:260px;height:260px;border-radius:64px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 30px 60px -20px rgba(0,0,0,.55),0 0 0 10px rgba(255,255,255,.12)}
.tile img{width:170px;height:170px;object-fit:contain}
.tile b{font-size:150px;font-weight:800;line-height:1}
.txt{position:absolute;top:104px;right:404px;left:80px}
.name{font-weight:800;font-size:92px;line-height:1.08;letter-spacing:-1px;text-align:right;unicode-bidi:plaintext;text-shadow:0 6px 30px rgba(0,0,0,.25)}
.name.s{font-size:74px}.name.xs{font-size:60px}
.sub{margin-top:18px;font-size:34px;font-weight:500;color:rgba(255,255,255,.82);text-align:right}
.badge{display:inline-block;margin-top:22px;background:#ffcf33;color:#1a1300;font-weight:800;font-size:30px;padding:8px 26px;border-radius:999px;box-shadow:0 10px 24px rgba(0,0,0,.3)}
.pills{position:absolute;bottom:72px;right:96px;left:80px;display:flex;gap:16px;flex-wrap:wrap}
.pill{display:flex;align-items:center;gap:12px;background:rgba(0,0,0,.26);border:2px solid rgba(255,255,255,.22);padding:12px 26px 14px;border-radius:999px;font-size:30px;font-weight:600}
.store{position:absolute;bottom:64px;left:72px;display:flex;align-items:center;gap:14px;opacity:.95}
.store img{width:58px;height:58px;border-radius:16px;background:#fff}
.store b{font-size:30px;font-weight:700}
.chips{position:absolute;bottom:80px;right:96px;left:96px;display:flex;flex-wrap:wrap;gap:14px;direction:ltr;justify-content:flex-end}
.chips span{background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.24);padding:10px 24px 12px;border-radius:999px;font-size:30px;font-weight:600}
.stamp{position:absolute;top:84px;left:84px;background:#ffcf33;color:#1a1300;font-weight:800;font-size:34px;padding:12px 30px;border-radius:999px;transform:rotate(-7deg);box-shadow:0 14px 30px rgba(0,0,0,.35)}
.conf{position:absolute;width:22px;height:40px;border-radius:6px}
"""

def page(body): return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS % FONT}</style></head><body><div id="b">{body}</div></body></html>'

def bg(a, b): return (f'<div class="bg" style="background:radial-gradient(circle at 12% 110%,{b}88,transparent 55%),radial-gradient(circle at 90% -10%,rgba(255,255,255,.22),transparent 45%),linear-gradient(125deg,{a} 0%,{b} 100%)"></div>'
                      '<div class="grid"></div><div class="streak"></div>')

def name_cls(n):
    n = len(n)
    return '' if n <= 14 else ' s' if n <= 20 else ' xs'

def product_html(p, settings):
    a, b = colours(p)
    nm = re.sub(r'\s+', ' ', str(p.get('name') or '')).strip()
    lg = logo(p)
    tile = f'<img src="{lg}">' if lg else f'<b style="color:{b}">{html.escape(nm[:1].upper())}</b>'
    badge = str(p.get('badge') or '').strip()
    pl = ''.join(f'<span class="pill">{ico(i)}{html.escape(t)}</span>' for i, t in pills(p, settings))
    sub = 'باقة توفير: اشتراكين بسعر أقل' if p.get('bundle') else cat_name(settings, p)
    return page(bg(a, b) + f'<div class="tile">{tile}</div><div class="txt"><div class="name{name_cls(nm)}">{html.escape(nm)}</div>' +
                (f'<div class="sub">{html.escape(sub)}</div>' if sub else '') + (f'<span class="badge">{html.escape(badge)}</span>' if badge else '') + '</div>'
                f'<div class="pills">{pl}</div><div class="store"><b>حازم ستور</b><img src="{STORE_LOGO}"></div>'), (nm, lg[:64] + hashlib.md5(lg.encode()).hexdigest(), badge, a, b, pl)

def home_html(products, settings):
    names = []
    for p in products:
        n = re.sub(r'\s+', ' ', str(p.get('name') or '')).strip()
        if re.match(r'^[A-Za-z]', n): names.append(n.split(' ')[0])
        if len(names) == 5: break
    store = str(settings.get('storeName') or 'حازم ستور')
    chips = ''.join(f'<span>{html.escape(n)}</span>' for n in names) + '<span>+ أكتر</span>'
    body = (bg('#071233', '#1f55e8') + '<div class="glow" style="width:520px;height:520px;top:-180px;right:-120px;background:rgba(56,194,247,.35)"></div>'
            f'<div class="tile" style="top:110px;width:220px;height:220px;border-radius:56px"><img src="{STORE_LOGO}" style="width:170px;height:170px"></div>'
            f'<div class="txt" style="top:126px;right:360px"><div class="name">{html.escape(store)}</div><div class="sub">اشتراكاتك الرقمية الرسمية بمكان واحد</div></div>'
            f'<span class="stamp">بالشيكل ₪</span><div class="chips">{chips}</div>')
    return page(body), (store, names)

def done_html():
    conf = ''.join(f'<i class="conf" style="top:{t}px;left:{l}px;background:{c};transform:rotate({r}deg)"></i>' for t, l, c, r in
                   [(70, 120, '#ffd166', 20), (150, 300, '#fff', -30), (90, 980, '#7fd4ff', 40), (470, 820, '#ffd166', -15), (500, 210, '#ff8fab', 25), (60, 640, '#ff8fab', -40), (420, 1120, '#fff', 30), (250, 60, '#7fd4ff', -20)])
    body = (bg('#0b3d2a', '#2fbf71') + conf + '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px">'
            f'<div style="width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.18);border:4px solid rgba(255,255,255,.4);display:flex;align-items:center;justify-content:center">'
            '<svg width="90" height="90" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg></div>'
            '<div class="name" style="text-align:center">اشتراكك جاهز!</div><div class="sub" style="text-align:center">شكراً إنك اخترت حازم ستور</div></div>'
            f'<div class="store"><b>حازم ستور</b><img src="{STORE_LOGO}"></div>')
    return page(body), ('done',)

# ---------------------------------------------------------------- «المنتجات»: the sections, then one section
SHOP_STYLE = 2
CAT = [  # (name, icon, accent)
    (r'ذكاء', 'spark', '#7c4dff'), (r'تصميم|مونتاج', 'pen', '#00bfa5'), (r'تعليم|إنتاج|انتاج', 'book', '#ff9800'),
    (r'انترنت|إنترنت', 'wifi', '#29b6f6'), (r'سوشال|تواصل', 'chat', '#e91e63'), (r'برمج', 'code', '#ff2d7a'),
    (r'افلام|أفلام|مسلسل', 'film', '#14a37c'), (r'العاب|ألعاب', 'game', '#8bc34a'),
]
ICON.update({
    'spark': '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    'pen': '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    'book': '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    'wifi': '<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>',
    'chat': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    'code': '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    'film': '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 8h5M2 16h5M17 8h5M17 16h5"/>',
    'game': '<rect x="2" y="7" width="20" height="12" rx="4"/><path d="M7 11v4M5 13h4"/><circle cx="16" cy="12" r="1"/><circle cx="18" cy="14" r="1"/>',
})
def cat_look(name):
    for rx, i, c in CAT:
        if re.search(rx, name or ''): return i, c
    return 'grid', '#5c7cfa'

def svc(n): return 'خدمة وحدة' if n == 1 else 'خدمتين' if n == 2 else f'{n} خدمات' if n <= 10 else f'{n} خدمة'

SHOP_CSS = """<style>
.glass{background:rgba(255,255,255,.10);border:2px solid rgba(255,255,255,.22);border-radius:34px;padding:22px 24px;display:flex;flex-direction:column;gap:16px;align-items:flex-start}
.glass h3{display:flex;align-items:center;gap:10px;font-size:28px;font-weight:700}
.lgs{display:flex;gap:12px}.lg{width:76px;height:76px;border-radius:20px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px rgba(0,0,0,.3)}
.lg img{width:54px;height:54px;object-fit:contain}.lg.big{width:200px;height:200px;border-radius:52px}.lg.big img{width:140px;height:140px}
.lg.ic{background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.3);color:#fff;box-shadow:none}
.mark{position:absolute;bottom:60px;right:96px;display:flex;align-items:center;gap:14px;opacity:.95}.mark img{width:54px;height:54px;border-radius:15px;background:#fff}.mark b{font-size:28px;font-weight:700}
.kick{font-size:32px;font-weight:700;color:#ffcf33}
.pillY{display:inline-block;margin-top:26px;background:#ffcf33;color:#1a1300;font-weight:800;font-size:30px;padding:10px 28px;border-radius:999px;box-shadow:0 10px 24px rgba(0,0,0,.3)}
</style>"""
MARK = f'<div class="mark"><img src="{STORE_LOGO}"><b>حازم ستور</b></div>'

def groups(products, settings):
    out = []
    for c in settings.get('categories') or []:
        lst = [p for p in products if p.get('cat') == c.get('id') and not p.get('bundle')]
        if lst and re.match(r'^[A-Za-z0-9_-]{1,60}$', str(c.get('id') or '')): out.append((c, lst))
    return out

def logos_of(lst, n):
    live = [p for p in lst if not p.get('soldOut')] + [p for p in lst if p.get('soldOut')]
    return [l for l in (logo(p) for p in live) if l][:n]

def shop_html(products, settings):
    gs = groups(products, settings)
    count = len([p for p in products if not p.get('bundle')])
    cards = []
    for c, lst in sorted(gs, key=lambda g: -len(logos_of(g[1], 3)))[:4]:
        i, _ = cat_look(c.get('name'))
        ls = logos_of(lst, 3)
        tiles = ''.join(f'<span class="lg"><img src="{l}"></span>' for l in ls) or f'<span class="lg ic">{ico(i, 40)}</span>'
        nm = re.sub(r'^خدمات\s+', '', str(c.get('name') or ''))
        cards.append(f'<div class="glass"><h3>{ico(i, 30)}{html.escape(nm)}</h3><div class="lgs">{tiles}</div></div>')
    body = (bg('#071233', '#1f55e8') + SHOP_CSS + '<div class="glow" style="width:520px;height:520px;top:-200px;right:-140px;background:rgba(56,194,247,.32)"></div>'
            f'<div class="txt" style="top:120px;right:96px;left:auto;width:400px"><div class="name" style="font-size:118px">المتجر</div>'
            f'<div class="sub">{html.escape(svc(count))} رقمية<br>بـ {len(gs)} أقسام</div><span class="pillY">كله بالشيكل ₪</span></div>'
            f'<div style="position:absolute;top:50%;left:70px;width:700px;transform:translateY(-50%) rotate(-4deg);display:grid;grid-template-columns:1fr 1fr;gap:22px">{"".join(cards)}</div>' + MARK)
    return page(body), (SHOP_STYLE, count, len(gs), cards)

def cat_html(c, lst):
    i, accent = cat_look(c.get('name'))
    nm = str(c.get('name') or '')
    ls = logos_of(lst, 4)
    if ls:
        pos = [(0, 0), (1, 0), (0, 1), (1, 1)] if len(ls) == 4 else [(0, 0), (1, 0), (0.5, 1)][:len(ls)] if len(ls) > 1 else [(0.5, 0.5)]
        tiles = ''.join(f'<span class="lg big" style="position:absolute;left:{x * 232}px;top:{y * 232 + (34 if x == 1 and len(ls) == 4 else 0)}px"><img src="{l}"></span>' for (x, y), l in zip(pos, ls))
    else:
        tiles = f'<span class="lg big ic" style="position:absolute;left:116px;top:116px">{ico(i, 120)}</span>'
    size = 104 if len(nm) <= 12 else 88 if len(nm) <= 18 else 72
    body = (bg('#071233', accent) + SHOP_CSS + f'<div class="glow" style="width:480px;height:480px;top:-180px;right:-120px;background:{accent}55"></div>'
            f'<div class="txt" style="top:100px;right:96px;left:auto;width:560px"><div class="kick" style="margin-bottom:10px">قسم</div><div class="name" style="font-size:{size}px;line-height:1.22">{html.escape(nm)}</div>'
            f'<div class="sub" style="margin-top:26px">{html.escape(svc(len(lst)))}</div></div>'
            f'<div style="position:absolute;top:70px;left:90px;width:432px;height:500px">{tiles}</div>' + MARK)
    return page(body), (SHOP_STYLE, nm, accent, len(lst), [hashlib.md5(l.encode()).hexdigest() for l in ls])

def h(x): return hashlib.sha1(json.dumps([STYLE, x], ensure_ascii=False, default=str).encode()).hexdigest()[:10]

def main():
    products, settings = load()
    products = sorted([p for p in products if sold(p)], key=lambda p: (p.get('sort') or 0, p['id']))
    jobs = {}
    hp, hk = home_html(products, settings); jobs['home'] = (hp, h(hk))
    dp, dk = done_html(); jobs['done'] = (dp, h(dk))
    sp, sk = shop_html(products, settings); jobs['shop'] = (sp, h(sk))
    for c, lst in groups(products, settings):
        cp, ck = cat_html(c, lst); jobs['cat-' + c['id']] = (cp, h(ck))
    for p in products:
        if not re.match(r'^[A-Za-z0-9_-]{1,80}$', p['id']): continue
        pp, pk = product_html(p, settings); jobs[p['id']] = (pp, h(pk))
    man_path = os.path.join(OUT, 'banners.json')
    old = json.load(open(man_path, encoding='utf-8')) if os.path.exists(man_path) else {}
    have = old.get('p') or {}
    todo = [k for k, (_, v) in jobs.items() if have.get(k) != v or not os.path.exists(os.path.join(OUT, k + '.jpg'))]
    gone = [k for k in have if k not in jobs]
    if CHECK:
        print('render=%d' % (1 if todo or gone else 0)); return
    os.makedirs(OUT, exist_ok=True)
    if todo:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            br = pw.chromium.launch(); pg = br.new_page(viewport={'width': 1280, 'height': 640})
            for k in todo:
                pg.set_content(jobs[k][0]); pg.evaluate('document.fonts.ready'); pg.wait_for_timeout(120)
                pg.screenshot(path=os.path.join(OUT, k + '.jpg'), type='jpeg', quality=86)
                print('drew', k)
            br.close()
    for k in gone:
        try: os.remove(os.path.join(OUT, k + '.jpg'))
        except FileNotFoundError: pass
    man = {'p': {k: v for k, (_, v) in jobs.items()}}
    if man != {'p': have}: json.dump(man, open(man_path, 'w', encoding='utf-8'), indent=0, sort_keys=True)
    print('banners', len(jobs), 'drawn', len(todo), 'removed', len(gone))

main()
