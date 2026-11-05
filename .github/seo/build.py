# -*- coding: utf-8 -*-
"""Static, crawlable pages for search engines and AI assistants, built from catalog.json:
one page per subscription (with prices + structured data), the home page's crawlable block, about + guide pages,
policies, sitemap, robots.txt and llms.txt. Unchanged pages keep their date, so the sitemap's lastmod stays honest.
Usage: build.py [REPO]   (writes the changed URLs to $SEO_CHANGED or /tmp/seo-changed.txt)"""
import os, re, json, html, sys, hashlib, datetime
from urllib.parse import quote
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import CSS, EARLY, FONTS, GUAR, TERMS, PRIV
from pages_data import PAGES
REPO = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath(os.path.join(HERE, '..', '..'))
SITE = 'https://hazem-store.com'; STORE = 'حازم ستور'; STORE_EN = 'Hazem Store'
WA = '970594826482'; WA_PRETTY = '+970 59 482 6482'
SOCIAL = []   # روابط صفحات المتجر (انستغرام، فيسبوك، تيك توك...) بتنحط هون وبتطلع بـ sameAs
TODAY = datetime.date.today().isoformat(); YEAR = datetime.date.today().year
cfg = open(os.path.join(REPO, 'config.js'), encoding='utf-8').read()
API_KEY = re.search(r'apiKey:\s*"([^"]+)"', cfg).group(1); PROJECT = re.search(r'projectId:\s*"([^"]+)"', cfg).group(1)
CAT = json.load(open(os.path.join(HERE, 'catalog.json'), encoding='utf-8'))
STATE_P = os.path.join(HERE, 'state.json'); STATE = json.load(open(STATE_P, encoding='utf-8')) if os.path.exists(STATE_P) else {}
E = lambda s: html.escape(str(s), quote=True)
DATE = '⁣DATE⁣'   # placeholder, swapped for the page's own date after hashing
def wa_link(t): return 'https://wa.me/%s?text=%s' % (WA, quote(t))
def fmt(n):
    n = round(float(n or 0), 2); return ('%d' % n) if n == int(n) else ('%g' % n)
def clean(n): return re.sub(r'^[ً-ٰٟ\s]+', '', str(n or '')).strip()

# ---------- catalogue ----------
CATS = {c['id']: c['name'] for c in CAT['cats']}
PAY = [m['name'] for m in CAT['payments']] or ['جوال باي', 'بال باي', 'بنك فلسطين', 'USDT']
PAY_TXT = '، '.join(PAY[:-1]) + ' و' + PAY[-1] if len(PAY) > 1 else PAY[0]
AUTO = [m['name'] for m in CAT['payments'] if m.get('auto')]
CUR = {p['id']: p for p in PAGES}
NEW_SLUG = {'esim-24jz': 'esim', 'p-hddf': 'instagram-accounts', 'p-mqvy': 'telegram-activation', 'shahid-vip-0iyv': 'shahid-vip', 'telegram-us': 'telegram-us-number'}
TITLE_OV = {'esim-24jz': 'شرائح إنترنت إلكترونية eSIM لغزة', 'shahid-vip-0iyv': 'اشتراك شاهد VIP في فلسطين', 'p-mqvy': 'تفعيل تيليجرام وحل مشكلة الدفع', 'p-hddf': 'حسابات انستغرام', 'telegram-us': 'حساب تيليجرام برقم أمريكي'}
NAME_OV = {'shahid-vip-0iyv': 'Shahid VIP', 'esim-24jz': 'شرائح إلكترونية eSIM'}
NEW_AR = {'esim-24jz': 'شرائح إلكترونية eSIM', 'shahid-vip-0iyv': 'شاهد VIP', 'p-mqvy': 'تفعيل تيليجرام', 'p-hddf': 'حسابات انستغرام', 'telegram-us': 'حساب تيليجرام برقم أمريكي'}
def slug_for(p):
    if p['id'] in CUR: return CUR[p['id']]['slug']
    if p['id'] in NEW_SLUG: return NEW_SLUG[p['id']]
    s = re.sub(r'[^a-z0-9-]+', '-', p['id'].lower()).strip('-'); return s or 'p-' + hashlib.md5(p['id'].encode()).hexdigest()[:6]
ITEMS = []
for p in CAT['products']:
    if p.get('active') is False or not p.get('plans'): continue
    c = CUR.get(p['id'], {})
    name = c.get('name') or NAME_OV.get(p['id']) or clean(p['name'])
    kw = [k.strip() for k in re.split('[،,]', p.get('keywords') or '') if k.strip()]
    ar = c.get('ar') or NEW_AR.get(p['id']) or next((k for k in kw if re.search('[؀-ۿ]', k)), name)
    cat = c.get('cat') or CATS.get(p.get('cat') or '', 'اشتراكات ثانية')
    lead = c.get('lead') or (p.get('desc') or '').strip().split('\n')[0][:260] or (f"{name} من {STORE} بأسعار بالشيكل ودفع محلي، وتفعيل على واتساب." + (f" {p['note']}." if p.get('note') else ''))
    feats = c.get('features') or [f for f in (p.get('features') or []) if f][:8]
    out_all = bool(p.get('soldOut'))
    plans = [{'name': clean(pl.get('name') or name), 'price': float(pl.get('price') or 0), 'compare': float(pl.get('compare') or 0), 'war': pl.get('war') or '', 'acct': pl.get('acct') or p.get('acct') or '', 'out': out_all or bool(pl.get('out'))} for pl in p['plans'] if (pl.get('price') or 0) > 0]
    if not plans: continue
    ITEMS.append({'id': p['id'], 'slug': slug_for(p), 'name': name, 'ar': ar, 'cat': cat, 'domain': c.get('domain') or p.get('domain') or '', 'kw': c.get('kw') or '، '.join(kw), 'lead': lead, 'features': feats, 'plans': plans, 'social': cat == 'خدمات السوشال ميديا' or p.get('cat') == 'social', 'sort': p.get('sort') or 0, 'catid': p.get('cat') or ''})
def lo(it): return min(x['price'] for x in it['plans'] if not x['out']) if any(not x['out'] for x in it['plans']) else min(x['price'] for x in it['plans'])
def hi(it): return max(x['price'] for x in it['plans'])
def avail(it): return any(not x['out'] for x in it['plans'])
def revs_for(it):
    w0 = it['name'].split()[0]; keys = [k.lower() for k in {it['name'], it['ar']} | ({w0} if re.match(r'^[A-Za-z][A-Za-z0-9]{3,}$', w0) else set()) if len(k) > 2]
    return [r for r in CAT['reviews'] if any(k in (r.get('product') or '').lower() for k in keys)]

# ---------- page shell ----------
def shell(title, desc, path, body, kw='', ld=None):
    url = SITE + path
    ldj = ('<script type="application/ld+json">%s</script>' % json.dumps(ld, ensure_ascii=False)) if ld else ''
    return f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}</title>
<meta name="description" content="{E(desc)}">
{('<meta name="keywords" content="%s">' % E(kw)) if kw else ''}
<link rel="canonical" href="{url}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#060b1e" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website"><meta property="og:locale" content="ar_PS"><meta property="og:site_name" content="{STORE}">
<meta property="og:title" content="{E(title)}"><meta property="og:description" content="{E(desc)}"><meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}/og-image.png"><meta name="twitter:card" content="summary_large_image">
{ldj}
{EARLY}
{FONTS}
<style>{CSS}
.rv{{display:grid;gap:10px}}.rv blockquote{{margin:0;padding:12px 14px;background:var(--surface);border:1px solid var(--line);border-radius:14px}}.rv cite{{display:block;margin-top:4px;font-style:normal;color:var(--muted);font-size:13px}}.stars{{color:#f5a524;letter-spacing:1px}}
.cats{{display:grid;gap:14px}}.cats h3{{margin:0 0 8px;font:800 17px var(--f-d)}}.cats ul{{list-style:none;margin:0;padding:0;display:grid;gap:8px}}.cats li a{{display:flex;justify-content:space-between;gap:10px;padding:12px 14px;background:var(--surface);border:1px solid var(--line);border-radius:14px;text-decoration:none;color:var(--fg);font-weight:600}}.cats li b{{color:var(--price);white-space:nowrap}}
</style>
</head>
<body>
<header class="hdr"><div class="wrap"><a class="brand" href="/"><img src="/logo.png" alt="" width="40" height="40">{STORE}</a><a class="btn pri" href="/#products">تسوّق الاشتراكات</a></div></header>
<main class="wrap">
{body}
</main>
<footer class="foot"><div class="wrap"><nav aria-label="روابط"><a href="/">المتجر</a><a href="/about/">عن حازم ستور</a><a href="/guide/">دليل الاشتراكات من فلسطين</a><a href="/guarantee.html">الضمان والاسترجاع</a><a href="/terms.html">شروط الاستخدام</a><a href="/privacy.html">سياسة الخصوصية</a><a href="{wa_link('مرحباً حازم ستور')}" target="_blank" rel="noopener">واتساب {WA_PRETTY}</a></nav><span>© {YEAR} {STORE} {STORE_EN}. أسماء التطبيقات وشعاراتها ملك لأصحابها، وحازم ستور مش تابع إلهم.</span></div></footer>
</body>
</html>
"""

def plan_html(it, x, wa):
    tags = []
    if x['out']: tags.append('<small class="w">نفدت الكمية حالياً</small>')
    if x['war'] == 'yes': tags.append('<small class="y">مع ضمان طول المدة</small>')
    elif x['war'] == 'no': tags.append('<small>بدون ضمان</small>')
    if x['acct'] == 'login': tags.append('<small class="w">على إيميلك الشخصي</small>')
    elif x['acct'] == 'email': tags.append('<small class="w">دعوة على إيميلك</small>')
    btn = f'<a class="btn" href="{E(wa)}" target="_blank" rel="noopener">اسأل</a>' if x['out'] else f'<a class="btn pri" href="/#p-{E(it["id"])}">اطلب</a>'
    return f'<div class="plan{" out" if x["out"] else ""}"><span class="n">{E(x["name"])}{"".join(tags)}</span><span class="p">{fmt(x["price"])} ₪</span>{btn}</div>'

LIVE_JS = r"""<script>
(function(){var box=document.getElementById('live'),pid=box.dataset.id;
function fv(v){if(!v)return null;if('stringValue' in v)return v.stringValue;if('integerValue' in v)return +v.integerValue;if('doubleValue' in v)return v.doubleValue;if('booleanValue' in v)return v.booleanValue;if('nullValue' in v)return null;if('timestampValue' in v)return Date.parse(v.timestampValue);if('arrayValue' in v)return (v.arrayValue.values||[]).map(fv);if('mapValue' in v){var o={},f=v.mapValue.fields||{};for(var k in f)o[k]=fv(f[k]);return o}return null}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmt(n){n=+n||0;return (Math.round(n*100)/100).toLocaleString('en-US')}
fetch('https://firestore.googleapis.com/v1/projects/__PROJECT__/databases/(default)/documents/products/'+encodeURIComponent(pid)+'?key=__KEY__').then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){var p=fv({mapValue:d});
  if(!p||p.active===false||!p.plans||!p.plans.length)return;
  box.innerHTML='<div class="plans">'+p.plans.map(function(pl){var acct=pl.acct||p.acct||'';var tags=[],out=!!(p.soldOut||pl.out);if(out)tags.push('<small class="w">نفدت الكمية حالياً</small>');if(pl.war==='yes')tags.push('<small class="y">مع ضمان طول المدة</small>');else if(pl.war==='no')tags.push('<small>بدون ضمان</small>');if(acct==='login')tags.push('<small class="w">على إيميلك الشخصي</small>');else if(acct==='email')tags.push('<small class="w">دعوة على إيميلك</small>');
    return '<div class="plan'+(out?' out':'')+'"><span class="n">'+esc(pl.name||p.name)+tags.join('')+'</span><span class="p">'+fmt(pl.price)+' ₪</span>'+(out?'<a class="btn" href="'+box.dataset.wa+'" target="_blank" rel="noopener">اسأل</a>':'<a class="btn pri" href="/#p-'+pid+'">اطلب</a>')+'</div>'}).join('')+'</div>'}).catch(function(){})})();
</script>""".replace('__PROJECT__', PROJECT).replace('__KEY__', API_KEY)

STORE_ID = SITE + '/#store'
def faq_common(name):
    return [(f"كيف بيتفعّل {name}؟", f"بتختار المدة من المتجر وبتدفع بـ{PAY_TXT}، وبعد ما نتأكد من الدفع بنفعّلك وبنبعتلك التفاصيل على واتساب وبحسابك بالموقع."),
            ("قديش بياخد التفعيل؟", "عادةً من دقائق لساعة بعد تأكيد الدفع." + (f" والدفع بـ{AUTO[0]} بيتأكد تلقائياً." if AUTO else "") + " وإذا دفعت من رصيدك بالموقع والمدة عليها تسليم فوري بتستلمها مباشرة."),
            ("هل عليه ضمان؟", "المدد المكتوب جنبها «مع ضمان» مضمونة طول مدة الاشتراك: إذا صار فيها أي خلل بنصلّحه أو بنبدّله مجاناً. التفاصيل بصفحة الضمان والاسترجاع."),
            ("شو طرق الدفع المتاحة؟", f"{PAY_TXT}، والأسعار بالشيكل.")]

def product_page(it):
    slug, name = it['slug'], it['name']
    title = f"{TITLE_OV[it['id']]} | {STORE}" if it['id'] in TITLE_OV else f"{name} | {STORE}" if it['social'] else f"اشتراك {name} في فلسطين | {STORE}"
    desc = (f"{it['ar']} ({name}) من {STORE}: يبدأ من {fmt(lo(it))} ₪. " + it['lead'])[:300] if it['ar'] != name else (f"{name} من {STORE}: يبدأ من {fmt(lo(it))} ₪. " + it['lead'])[:300]
    wa = wa_link(f'مرحباً {STORE}، بدي أسأل عن {name}')
    others = [x for x in ITEMS if x['slug'] != slug]; same = [x for x in others if x['cat'] == it['cat']] + [x for x in others if x['cat'] != it['cat']]
    faq = faq_common(name); rv = revs_for(it)
    offer = {"@type": "AggregateOffer", "priceCurrency": "ILS", "lowPrice": fmt(lo(it)), "highPrice": fmt(hi(it)), "offerCount": len(it['plans']),
             "availability": "https://schema.org/InStock" if avail(it) else "https://schema.org/OutOfStock", "url": SITE + f"/{slug}/", "seller": {"@type": "OnlineStore", "@id": STORE_ID, "name": STORE, "url": SITE + "/"}}
    prod = {"@type": "Product", "@id": SITE + f"/{slug}/#product", "name": name, "alternateName": it['ar'], "description": it['lead'], "image": SITE + "/og-image.png", "url": SITE + f"/{slug}/", "category": it['cat'], "offers": offer}
    if len(rv) >= 2:
        prod["aggregateRating"] = {"@type": "AggregateRating", "ratingValue": round(sum(r['rating'] for r in rv) / len(rv), 1), "reviewCount": len(rv), "bestRating": 5, "worstRating": 1}
        prod["review"] = [{"@type": "Review", "author": {"@type": "Person", "name": r['name'] or 'زبون'}, "reviewRating": {"@type": "Rating", "ratingValue": r['rating'], "bestRating": 5}, "reviewBody": r['text'], **({"datePublished": r['at']} if r['at'] else {})} for r in rv[:5] if r['text']]
    ld = {"@context": "https://schema.org", "@graph": [prod,
          {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": STORE, "item": SITE + "/"}, {"@type": "ListItem", "position": 2, "name": it['cat'], "item": SITE + "/#products"}, {"@type": "ListItem", "position": 3, "name": name, "item": SITE + f"/{slug}/"}]},
          {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]}]}
    icon = ('<img src="https://www.google.com/s2/favicons?domain=%s&sz=128" alt="" width="50" height="50" referrerpolicy="no-referrer">' % E(it['domain'])) if it['domain'] else '<b class="ic-l">%s</b>' % E(name[0])
    rv_html = ('<h2>تجارب الزباين</h2><div class="rv">' + ''.join(f'<blockquote><span class="stars" aria-label="{r["rating"]} من 5">{"★" * int(r["rating"])}{"☆" * (5 - int(r["rating"]))}</span><p style="margin:6px 0 0">{E(r["text"])}</p><cite>{E(r["name"] or "زبون")}{(" · " + r["at"]) if r["at"] else ""}</cite></blockquote>' for r in rv[:3] if r['text']) + '</div>') if rv else ''
    body = f"""<p class="crumbs"><a href="/">{STORE}</a> › <a href="/#products">{E(it['cat'])}</a> › {E(name)}</p>
<section class="hero"><span class="ic">{icon}</span><div><h1>{E(title.split(' | ')[0])}</h1><p>{E(it['lead'])}</p></div>
<div class="cta"><a class="btn pri" href="/#p-{E(it['id'])}">اطلب الآن</a><a class="btn wa" href="{E(wa)}" target="_blank" rel="noopener">اسأل على واتساب</a></div></section>
<h2>المدد والأسعار</h2>
<div id="live" data-id="{E(it['id'])}" data-wa="{E(wa)}"><div class="plans">{''.join(plan_html(it, x, wa) for x in it['plans'])}</div></div>
<p class="muted" style="font-size:13px;margin:8px 0 0">الأسعار بالشيكل، محدّثة بتاريخ {DATE}.</p>
{('<h2>شو بتاخد مع %s</h2><ul class="feat">%s</ul>' % (E(name), ''.join('<li>%s</li>' % E(f) for f in it['features']))) if it['features'] else ''}
<h2>كيف تطلب؟</h2>
<ol class="steps"><li><b>اختار المدة</b><span>من المتجر، وشوف جنب كل مدة إذا عليها ضمان وكيف بتتفعّل.</span></li><li><b>ادفع وأثبت الدفع</b><span>{E(PAY_TXT)}، واكتب بيانات الحوالة أو ارفع سكرين.</span></li><li><b>استلم التفعيل</b><span>بنفعّلك وبنبعتلك التفاصيل على واتساب أول ما نتأكد من الدفع.</span></li></ol>
{rv_html}
<h2>أسئلة شائعة</h2>
{''.join('<details><summary>%s</summary><p>%s</p></details>' % (E(q), E(a)) for q, a in faq)}
<h2>اشتراكات ثانية</h2>
<nav class="rel">{''.join('<a href="/%s/">%s</a>' % (x['slug'], E(x['name'])) for x in same)}</nav>
{LIVE_JS}"""
    return shell(title, desc, f'/{slug}/', body, (it['kw'] + f', {STORE}, {STORE_EN}').strip(', '), ld)

def doc_page(path, title, desc, inner, ld=None):
    return shell(f'{title} | {STORE}', desc, path, f'<article class="doc"><h1>{E(title)}</h1><p class="muted">آخر تحديث: {DATE}</p>{inner}</article>', '', ld)

def cats_html(tag='h3'):
    groups = {}
    for it in sorted(ITEMS, key=lambda x: x['sort']): groups.setdefault(it['cat'], []).append(it)
    return '<div class="cats">' + ''.join(f'<section><{tag}>{E(c)}</{tag}><ul>' + ''.join(f'<li><a href="/{it["slug"]}/"><span>{E(it["name"])}</span><b>من {fmt(lo(it))} ₪</b></a></li>' for it in its) + '</ul></section>' for c, its in groups.items()) + '</div>'

ABOUT = f"""<p>{STORE} ({STORE_EN}) متجر إلكتروني فلسطيني لبيع الاشتراكات الرقمية والخدمات على الإنترنت، بأسعار بالشيكل ودفع بطرق محلية. الموقع: <a href="/">hazem-store.com</a>.</p>
<h2>شو بنبيع؟</h2><p>اشتراكات أدوات الذكاء الاصطناعي، التصميم والمونتاج، التعليم والإنتاجية، البرمجة، الأفلام والمسلسلات، شرائح إنترنت إلكترونية، وخدمات السوشال ميديا. القائمة الكاملة مع الأسعار:</p>
__CATS__
<h2>كيف بنشتغل؟</h2><ul><li>بتختار الاشتراك والمدة من الموقع، وبتشوف جنب كل مدة إذا عليها ضمان، وإذا بتتفعّل على إيميلك الشخصي أو على حساب جاهز.</li><li>بتدفع بـ{E(PAY_TXT)}.{(' الدفع بـ' + E(AUTO[0]) + ' بيتأكد تلقائياً.') if AUTO else ''}</li><li>بنفعّلك الاشتراك وبنبعتلك التفاصيل على واتساب وبحسابك بالموقع، وبعض المدد بتتسلم فوراً.</li><li>بحسابك بتتابع طلباتك، وبتشوف قديش باقي على كل اشتراك، وبتجدّد بكبسة.</li></ul>
<h2>الضمان</h2><p>المدد المكتوب جنبها «مع ضمان» مضمونة طول مدة الاشتراك: إذا صار فيها خلل بنصلّحها أو بنبدّلها مجاناً. التفاصيل بصفحة <a href="/guarantee.html">الضمان والاسترجاع</a>.</p>
<h2>تواصل معنا</h2><p>واتساب <a href="{wa_link('مرحباً حازم ستور')}" dir="ltr">{WA_PRETTY}</a>، أو «الدعم الفني» من داخل الموقع.</p>"""

GUIDE = f"""<p>كثير ناس بفلسطين بدهم ChatGPT Plus أو Canva Pro أو CapCut Pro، بس مش كل حدا عنده بطاقة دفع دولية، وأحياناً البطاقة بتنرفض بمواقع الاشتراكات. هاد الدليل بيشرح الخيارات وشو تنتبه إله.</p>
<h2>١. الدفع المباشر للشركة</h2><p>إذا عندك بطاقة فيزا أو ماستركارد مفعّل عليها الدفع الدولي، بتقدر تشترك من موقع الشركة نفسها. انتبه للسعر بالدولار، ولرسوم البنك على العملة الأجنبية.</p>
<h2>٢. الشراء من متجر محلي بالشيكل</h2><p>متاجر زي {STORE} بتخليك تدفع بـ{E(PAY_TXT)}، والمتجر بيفعّلك الاشتراك. هيك ما بتحتاج بطاقة دولية، والسعر واضح بالشيكل من الأول.</p>
<h2>٣. افهم نوع الاشتراك قبل ما تدفع</h2><ul><li><b>على إيميلك الشخصي:</b> الاشتراك بيتفعّل على حسابك أنت، وبتضل محادثاتك وملفاتك عندك. هاد الأفضل إذا متوفر.</li><li><b>دعوة على إيميلك:</b> بتوصلك دعوة لفريق أو عائلة، وبتدخل بحسابك.</li><li><b>حساب جاهز:</b> بتستلم حساب جديد فيه الاشتراك. أرخص غالباً، بس الحساب مش باسمك.</li><li><b>مشترك مع شخص أو أكثر:</b> سعر أقل مقابل إنه الحساب مشترك.</li></ul>
<h2>٤. نصائح قبل الشراء</h2><ul><li>اسأل إذا المدة عليها ضمان، وشو بيصير إذا وقف الاشتراك قبل ما تخلص مدته.</li><li>إذا طُلب منك كلمة سر حسابك، غيّرها بعد التفعيل.</li><li>احتفظ بإثبات الدفع ورقم الطلب.</li><li>تأكد من المدة بالضبط (شهر، ٣ أشهر، سنة)، وقارن السعر بالشهر.</li></ul>
<h2>الأسعار عندنا</h2>__CATS__
<p>عندك سؤال؟ راسلنا على واتساب <a href="{wa_link('مرحباً حازم ستور، عندي سؤال عن الاشتراكات')}" dir="ltr">{WA_PRETTY}</a>.</p>"""

def home_block():
    n = len(ITEMS)
    faq = faq_common('الاشتراك')
    return (f'<!--seo:start--><div class="seo-pre" style="max-width:960px;margin:0 auto;padding:28px 16px 48px;font-family:Alexandria,system-ui,sans-serif;color:#0a1640;line-height:1.8">'
            f'<h1 style="font-size:26px;margin:0 0 8px">{STORE} {STORE_EN}: متجر اشتراكات رقمية في فلسطين</h1>'
            f'<p>{n} اشتراك وخدمة رقمية بأسعار بالشيكل: ' + '، '.join(E(it['name']) for it in sorted(ITEMS, key=lambda x: x['sort'])[:14]) + f' وغيرها. الدفع بـ{E(PAY_TXT)}، والتفعيل على واتساب وبحسابك بالموقع.</p>'
            '<h2 style="font-size:20px">الاشتراكات والأسعار</h2><ul>' + ''.join(f'<li><a href="/{it["slug"]}/">{E(it["name"])}</a> ({E(it["cat"])}): ' + '، '.join(f'{E(x["name"])} {fmt(x["price"])} ₪' for x in it['plans'][:4]) + ('…' if len(it['plans']) > 4 else '') + '</li>' for it in sorted(ITEMS, key=lambda x: x['sort'])) + '</ul>'
            '<h2 style="font-size:20px">أسئلة شائعة</h2>' + ''.join(f'<h3 style="font-size:16px;margin:12px 0 2px">{E(q)}</h3><p style="margin:0">{E(a)}</p>' for q, a in faq) +
            f'<p><a href="/about/">عن حازم ستور</a> · <a href="/guide/">دليل شراء الاشتراكات من فلسطين</a> · <a href="/guarantee.html">الضمان والاسترجاع</a> · واتساب <span dir="ltr">{WA_PRETTY}</span></p></div><!--seo:end-->')

def home_ld():
    return {"@context": "https://schema.org", "@graph": [
        {"@type": "WebSite", "@id": SITE + "/#website", "name": STORE, "alternateName": [STORE_EN, "HazemStore", "hazem store", "حازم ستور"], "url": SITE + "/", "inLanguage": "ar", "publisher": {"@id": STORE_ID}},
        {"@type": "OnlineStore", "@id": STORE_ID, "name": STORE, "alternateName": [STORE_EN, "HazemStore", "hazem store"], "url": SITE + "/", "logo": SITE + "/logo.png", "image": SITE + "/og-image.png",
         "description": f"{STORE} ({STORE_EN}): متجر اشتراكات رقمية في فلسطين. " + '، '.join(it['name'] for it in sorted(ITEMS, key=lambda x: x['sort'])[:8]) + f" وغيرها بأسعار بالشيكل. الدفع بـ{PAY_TXT}، وتفعيل سريع على واتساب.",
         "telephone": "+970594826482", "areaServed": {"@type": "Country", "name": "Palestine"}, "address": {"@type": "PostalAddress", "addressCountry": "PS"},
         "currenciesAccepted": "ILS", "paymentAccepted": "، ".join(PAY), "priceRange": f"{fmt(min(lo(i) for i in ITEMS))}–{fmt(max(hi(i) for i in ITEMS))} ₪",
         "contactPoint": {"@type": "ContactPoint", "telephone": "+970594826482", "contactType": "customer service", "availableLanguage": ["ar", "en"]},
         **({"sameAs": SOCIAL} if SOCIAL else {}),
         "hasOfferCatalog": {"@type": "OfferCatalog", "name": "الاشتراكات الرقمية", "itemListElement": [{"@type": "Offer", "itemOffered": {"@type": "Product", "name": it['name'], "url": SITE + f"/{it['slug']}/"}, "price": fmt(lo(it)), "priceCurrency": "ILS", "availability": "https://schema.org/InStock" if avail(it) else "https://schema.org/OutOfStock"} for it in sorted(ITEMS, key=lambda x: x['sort'])]}}]}

def llms():
    L = [f"# {STORE} ({STORE_EN})", "", f"> متجر إلكتروني فلسطيني للاشتراكات الرقمية: {len(ITEMS)} اشتراك وخدمة بأسعار بالشيكل، دفع بـ{PAY_TXT}، وتفعيل على واتساب وبحساب الزبون بالموقع. الموقع: {SITE}/", "",
         f"- واتساب: {WA_PRETTY}", "- المدد المكتوب جنبها «مع ضمان» مضمونة طول مدة الاشتراك.", f"- الأسعار محدّثة بتاريخ {DATE}.", "", "## الاشتراكات"]
    for it in sorted(ITEMS, key=lambda x: x['sort']):
        L.append(f"- [{it['name']}]({SITE}/{it['slug']}/): {it['cat']}. " + '، '.join(f"{x['name']} {fmt(x['price'])} ₪" for x in it['plans'][:5]))
    L += ["", "## صفحات مهمة", f"- [عن حازم ستور]({SITE}/about/)", f"- [دليل شراء الاشتراكات الرقمية من فلسطين]({SITE}/guide/)", f"- [الضمان والاسترجاع]({SITE}/guarantee.html)", f"- [شروط الاستخدام]({SITE}/terms.html)", f"- [سياسة الخصوصية]({SITE}/privacy.html)", ""]
    return '\n'.join(L)

ROBOTS = """# حازم ستور: محركات البحث ومساعدات الذكاء الاصطناعي مرحّب فيها
User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /__/
Disallow: /worker/
Disallow: /README.md

""" + ''.join(f"User-agent: {b}\nAllow: /\nDisallow: /admin.html\nDisallow: /__/\nDisallow: /worker/\nDisallow: /README.md\n\n" for b in ('Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot', 'Applebot-Extended', 'DuckDuckBot', 'YandexBot')) + f"Sitemap: {SITE}/sitemap.xml\n"

# ---------- write, keeping dates of unchanged pages ----------
CHANGED = []
def put(rel, txt, url=None):
    h = hashlib.sha256(txt.encode('utf-8')).hexdigest()[:16]; st = STATE.get(rel)
    d = st['d'] if st and st['h'] == h else TODAY
    if not st or st['h'] != h:
        STATE[rel] = {'h': h, 'd': TODAY}
        if url: CHANGED.append(url)
    out = txt.replace(DATE, d)
    i = out.find('<body')
    if i > -1: out = out[:i] + re.sub(r'(^|[^؀-ۿ])(و)(?=[A-Za-z])', lambda m: m.group(1) + m.group(2) + ' ', out[i:])
    p = os.path.join(REPO, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    if not os.path.exists(p) or open(p, encoding='utf-8').read() != out: open(p, 'w', encoding='utf-8').write(out)
    return d

urls = []
for it in ITEMS: urls.append((f"/{it['slug']}/", put(f"{it['slug']}/index.html", product_page(it), SITE + f"/{it['slug']}/"), '0.8', 'weekly'))
urls.append(('/about/', put('about/index.html', doc_page('/about/', 'عن حازم ستور', f'{STORE} ({STORE_EN}): متجر اشتراكات رقمية فلسطيني بأسعار بالشيكل ودفع محلي. شو بنبيع، كيف بنشتغل، الضمان، وكيف تتواصل معنا.', ABOUT.replace('__CATS__', cats_html()), {"@context": "https://schema.org", "@type": "AboutPage", "url": SITE + "/about/", "mainEntity": {"@id": STORE_ID}}), SITE + '/about/'), '0.7', 'monthly'))
urls.append(('/guide/', put('guide/index.html', doc_page('/guide/', 'كيف تشتري اشتراكات رقمية من فلسطين وتدفع بالشيكل', 'دليل عملي: كيف تشترك بـ ChatGPT Plus وCanva وCapCut وغيرها من فلسطين بدون بطاقة دولية، أنواع الاشتراكات، ونصائح قبل الدفع.', GUIDE.replace('__CATS__', cats_html()), {"@context": "https://schema.org", "@type": "Article", "headline": "كيف تشتري اشتراكات رقمية من فلسطين وتدفع بالشيكل", "inLanguage": "ar", "author": {"@id": STORE_ID}, "publisher": {"@id": STORE_ID}, "mainEntityOfPage": SITE + "/guide/"}), SITE + '/guide/'), '0.7', 'monthly'))
urls.append(('/guarantee.html', put('guarantee.html', doc_page('/guarantee.html', 'الضمان والاسترجاع', 'سياسة الضمان والاسترجاع في حازم ستور: ضمان طول مدة الاشتراك للمدد المضمونة، ومتى بينرجع المبلغ.', GUAR), SITE + '/guarantee.html'), '0.5', 'monthly'))
urls.append(('/terms.html', put('terms.html', doc_page('/terms.html', 'شروط الاستخدام', 'شروط استخدام متجر حازم ستور للاشتراكات الرقمية: الطلبات والدفع والتسليم.', TERMS), SITE + '/terms.html'), '0.3', 'yearly'))
urls.append(('/privacy.html', put('privacy.html', doc_page('/privacy.html', 'سياسة الخصوصية', 'سياسة الخصوصية في حازم ستور: شو المعلومات اللي بنجمعها وكيف بنحميها.', PRIV), SITE + '/privacy.html'), '0.3', 'yearly'))

# home: title/description, structured data and the crawlable block inside #root (the app replaces it when it loads)
ip = os.path.join(REPO, 'index.html'); h = open(ip, encoding='utf-8').read()
TITLE = f'{STORE} {STORE_EN} | متجر اشتراكات رقمية في فلسطين بالشيكل'
DESC = f"{STORE} ({STORE_EN}): متجر اشتراكات رقمية في فلسطين. ChatGPT Plus وClaude وGemini وCanva وCapCut وOffice 365 وغيرها بأسعار بالشيكل، دفع بـ{PAY_TXT}، وتفعيل سريع على واتساب."
h = re.sub(r'<title>.*?</title>', lambda m: f'<title>{E(TITLE)}</title>', h, count=1, flags=re.S)
h = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + E(DESC) + m.group(2), h, count=1)
h = re.sub(r'(<meta property="og:title" content=")[^"]*(")', lambda m: m.group(1) + E(TITLE) + m.group(2), h, count=1)
h = re.sub(r'<script type="application/ld\+json">.*?</script>', lambda m: '<script type="application/ld+json">' + json.dumps(home_ld(), ensure_ascii=False) + '</script>', h, count=1, flags=re.S)
h = re.sub(r'<!--seo:start-->.*?<!--seo:end-->', '', h, flags=re.S)
a = h.index('<div id="root">'); b = h.index('</div>\n<script>window.HAZEM_BUILD', a)
h = h[:a] + h[a:b] + home_block() + h[b:]
blk = re.search(r'<!--seo:start-->.*?<!--seo:end-->', h, re.S).group(0) + json.dumps(home_ld(), ensure_ascii=False) + TITLE + DESC
hh = hashlib.sha256(blk.encode()).hexdigest()[:16]; st = STATE.get('index.html')
if not st or st['h'] != hh: STATE['index.html'] = {'h': hh, 'd': TODAY}; CHANGED.append(SITE + '/')
open(ip, 'w', encoding='utf-8').write(h)
urls.insert(0, ('/', STATE['index.html']['d'], '1.0', 'daily'))

llms_d = put('llms.txt', llms(), SITE + '/llms.txt')
open(os.path.join(REPO, 'robots.txt'), 'w', encoding='utf-8').write(ROBOTS)
sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + ''.join(f'  <url>\n    <loc>{SITE}{u}</loc>\n    <lastmod>{d}</lastmod>\n    <changefreq>{f}</changefreq>\n    <priority>{pr}</priority>\n  </url>\n' for u, d, pr, f in urls) + '</urlset>\n'
open(os.path.join(REPO, 'sitemap.xml'), 'w', encoding='utf-8').write(sm)
# drop pages of subscriptions that were removed from the store
live = {it['slug'] for it in ITEMS}
for rel in list(STATE):
    m = re.match(r'^([a-z0-9-]+)/index\.html$', rel)
    if m and m.group(1) not in live | {'about', 'guide'}:
        p = os.path.join(REPO, rel)
        if os.path.exists(p): os.remove(p)
        try: os.rmdir(os.path.dirname(p))
        except OSError: pass
        del STATE[rel]; CHANGED.append(f'{SITE}/{m.group(1)}/')
json.dump(STATE, open(STATE_P, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, sort_keys=True)
open(os.environ.get('SEO_CHANGED', '/tmp/seo-changed.txt'), 'w').write('\n'.join(CHANGED))
print('items', len(ITEMS), 'urls', len(urls), 'changed', len(CHANGED))
