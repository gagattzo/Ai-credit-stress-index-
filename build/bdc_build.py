"""Builds the data behind aistress.si/bdc from the ACSI Lab register (research/bdc/*.csv in gagattzo/acsi-lab).

  python build/bdc_build.py /path/to/acsi-lab

Writes bdc.json (downloadable) and fills the data block and headline figures in bdc.html. Only rows a maintainer
signed off in research/bdc/review_log.csv are used; keyword leads never are.
"""
import csv, json, pathlib, re, sys, datetime as dt

SITE = pathlib.Path(__file__).resolve().parent.parent
LAB = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '../acsi-lab')
PAT = {
    'CoreWeave': r'core\s*weave', 'Crusoe': r'crusoe', 'Nscale': r'nscale', 'Firmus': r'firmus', 'Together AI': r'together\s*(ai|computer)',
    'Galaxy Digital': r'galaxy\s*(digital|helios)', 'Vantage Data Centers': r'(retained\s+)?vantage\s*data', 'EdgeConneX': r'edgeconnex',
    'CyrusOne': r'cyrusone', 'QTS': r'\bqts\b',
}
STOP = re.compile(r'\s(\||Industry|Investment|Type|Instrument|Reference|Interest|Commitment|Initial|Security|Senior|First|1st|Delayed|Revolv'
                  r'|Non-Affiliated|Non Affiliated|Preferred|Series|Equity|Common|Private|Equipment|Tranche|Term|Unsecured|-\s|,\s+Delayed|,\s+First|,\s+Senior)', re.I)
KIND = {'neocloud': 'Neoclouds', 'ai-hpc': 'AI / HPC campuses', 'data-center': 'Hyperscale data-center developers'}
ACR = {'Bdc': 'BDC', 'Llc': 'LLC', 'Ii': 'II', 'Hps': 'HPS', 'Msd': 'MSD', 'Ab': 'AB', 'Bsp': 'BSP', 'Pimco': 'PIMCO', 'Inc.': 'Inc.', 'Corp.': 'Corp.'}


def nice(name):
    return ' '.join(ACR.get(w, w) for w in name.title().split())


def obligor(text, group):
    m = re.search(PAT[group], text, re.I)
    if not m:
        return group
    tail = text[m.start():]
    cut = STOP.search(tail)
    out = (tail[:cut.start()] if cut else tail[:80]).strip(' ,|-')
    out = re.sub(r'\s+', ' ', out)
    out = re.sub(r'\s+IT Services$|\s+\d$', '', out)                       # sector labels and tranche counters
    half = out[:len(out) // 2].strip()
    if half and out.count(half) > 1:                                     # "X LLC X LLC" written twice
        out = half
    out = re.sub(r'(?i)coreweave', 'CoreWeave', out)
    if ' and ' in out and len(out) > 50:                                 # "A, LP and A Assets, LP": keep the first obligor
        out = out.split(' and ')[0]
    if out.isupper():
        out = ' '.join(ACR.get(w.title(), w.title()) if w not in ('UK', 'LTD') else ('UK' if w == 'UK' else 'Ltd') for w in out.split())
    return out[:90] or group


def instrument(text):
    t = text.lower()
    for k, v in (('preferred', 'Preferred equity'), ('equipment financ', 'Equipment financing'), ('asset-backed', 'Asset-backed'),
                 ('mortgage', 'Mortgage loan'), ('unsecured bond', 'Unsecured bond'), ('subordinated', 'Subordinated loan'),
                 ('warehouse', 'Warehouse facility'), ('delayed draw', 'Delayed-draw term loan'), ('ddtl', 'Delayed-draw term loan'), ('revolv', 'Revolver'),
                 ('equity', 'Equity'), ('common', 'Equity'), ('units', 'Equity'), ('first lien', 'First-lien loan'), ('1st lien', 'First-lien loan'),
                 ('senior secured', 'Senior secured loan'), ('jv', 'Joint venture')):
        if k in t:
            return v
    return 'Loan'


def main():
    reg = [r for r in csv.DictReader(open(LAB / 'research/bdc/register.csv'))
           if r['status'] == 'signed off' and r['funded'] == 'True' and r['match_rule'] == 'named obligor']
    hold = list(csv.DictReader(open(LAB / 'research/bdc/holders.csv')))
    f = lambda v: float(v) if v not in ('', None) else None
    fac = []
    for r in reg:
        ins = instrument(r['obligor_text'])
        fac.append({'holder': nice(r['holder']), 'cik': r['holder_cik'], 'group': r['borrower_group'], 'kind': r['category'],
                    'obligor': obligor(r['obligor_text'], r['borrower_group']), 'instrument': ins,
                    'debt': not ins.endswith('equity') and ins != 'Equity' and ins != 'Joint venture',
                    'cost': f(r['cost']), 'fv': f(r['fair_value']), 'maturity': r['maturity'] or None, 'mark_date': r['mark_date'],
                    'filed': r['filed'], 'url': r['filing_url']})
    fac.sort(key=lambda x: (-(x['fv'] or 0)))
    S = lambda xs, k: sum(x[k] or 0 for x in xs)
    debt = [x for x in fac if x['debt']]; eq = [x for x in fac if not x['debt']]
    groups = {}
    for x in fac:
        g = groups.setdefault(x['group'], {'group': x['group'], 'kind': x['kind'], 'holders': set(), 'facilities': 0, 'cost': 0, 'fv': 0,
                                           'debt_cost': 0, 'debt_fv': 0})
        g['holders'].add(x['cik']); g['facilities'] += 1; g['cost'] += x['cost'] or 0; g['fv'] += x['fv'] or 0
        if x['debt']:
            g['debt_cost'] += x['cost'] or 0; g['debt_fv'] += x['fv'] or 0
    gl = sorted(({**g, 'holders': len(g['holders'])} for g in groups.values()), key=lambda g: -g['fv'])
    hl = [{'holder': nice(h['holder']), 'cik': h['holder_cik'], 'mark_date': h['mark_date'], 'facilities': int(h['facilities']),
           'groups': h['groups'].split('; '), 'cost': f(h['cost']), 'fv': f(h['fair_value']), 'net_assets': f(h['net_assets']),
           'pct_nav': f(h['ai_fv_pct_nav']), 'url': h['filing_url']} for h in hold]
    low = min(debt, key=lambda x: x['fv'] / x['cost'])
    data = {
        'built': dt.date.today().isoformat(), 'as_of': max(x['mark_date'] for x in fac), 'mark_dates': sorted({x['mark_date'] for x in fac}),
        'source': 'SEC BDC Data Sets (soi.tsv), files 2026_08, 2026_09, 2026_10', 'register': 'https://github.com/gagattzo/acsi-lab/tree/main/research/bdc',
        'totals': {'bdcs': len({x['cik'] for x in fac}), 'groups': len(gl), 'facilities': len(fac), 'cost': S(fac, 'cost'), 'fv': S(fac, 'fv'),
                   'debt_facilities': len(debt), 'debt_cost': S(debt, 'cost'), 'debt_fv': S(debt, 'fv'),
                   'equity_positions': len(eq), 'equity_cost': S(eq, 'cost'), 'equity_fv': S(eq, 'fv'),
                   'debt_below_097': sum(1 for x in debt if x['fv'] / x['cost'] < 0.97),
                   'lowest_debt_mark': {'ratio': round(low['fv'] / low['cost'], 4), 'obligor': low['obligor'], 'holder': low['holder']}},
        'groups': gl, 'holders': hl, 'facilities': fac,
    }
    (SITE / 'bdc.json').write_text(json.dumps(data, indent=1))
    page = (SITE / 'bdc.html').read_text()
    blob = json.dumps(data, separators=(',', ':')).replace('</', '<\\/')
    page = re.sub(r'(<script id="bdc-data" type="application/json">).*?(</script>)', lambda m: m.group(1) + blob + m.group(2), page, flags=re.S)
    T = data['totals']
    cw = next(g for g in gl if g['group'] == 'CoreWeave')
    mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    main_date = max(set(x['mark_date'] for x in fac), key=lambda d: sum(1 for x in fac if x['mark_date'] == d))
    y, mo, d = main_date.split('-')
    low_who = re.sub(r',? ?(PTY|Ltd|LLC|Inc)\.?', '', T['lowest_debt_mark']['obligor']).replace(' Supercloud', '').strip() + ' at ' + \
        T['lowest_debt_mark']['holder'].split(' ')[0]
    vals = {'n-bdcs': str(T['bdcs']), 'n-cost': f"${T['cost'] / 1e9:.2f}bn", 'n-debt-ratio': f"{T['debt_fv'] / T['debt_cost']:.3f}×",
            'n-facilities': str(T['facilities']), 'n-cw-holders': str(cw['holders']), 'n-cw-fv': f"${cw['fv'] / 1e6:,.0f}m",
            'n-below': str(T['debt_below_097']), 'n-low': f"{T['lowest_debt_mark']['ratio']:.3f}×", 'n-low-who': low_who,
            'n-asof': f"{int(d)} {mon[int(mo) - 1]} {y}",
            'n-top': ' · '.join(f"{g['group'].replace(' Data Centers', '')} ${g['fv'] / 1e6:,.0f}m" for g in gl[:7])}
    fill = lambda html: re.sub(r'(<(span|div) ([^>]*?)data-k="([a-z-]+)">)(.*?)(</\2>)',
                               lambda m: m.group(1) + (vals[m.group(4)] if m.group(4) in vals else m.group(5)) + m.group(6), html)
    (SITE / 'bdc.html').write_text(fill(page))
    idx = SITE / 'index.html'
    idx.write_text(fill(idx.read_text()))
    print(json.dumps(T, indent=1))
    for x in fac:
        print(f"{x['group'][:14]:14} | {x['obligor'][:48]:48} | {x['instrument'][:22]:22} | {x['holder'][:30]}")


if __name__ == '__main__':
    main()
