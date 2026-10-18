# Copies the shared header, footer and logo symbol from rev-site-v2/contact.html into pages
# that use <!--SYMBOL-->, <!--HEADER-->, <!--FOOTER--> placeholders, setting aria-current.
import re, sys
src = open('rev-site-v2/contact.html').read()
symbol = re.search(r'<svg width="0".*?</svg>', src, re.S).group(0)
header = re.search(r'<!-- header:start -->.*?<!-- header:end -->', src, re.S).group(0)
footer = re.search(r'<!-- footer:start -->.*?<!-- footer:end -->', src, re.S).group(0)
header = header.replace(' aria-current="page"', '')
for page, current in [a.split(':') if ':' in a else (a, '') for a in sys.argv[1:]]:
    t = open(page).read()
    h = header
    if current:
        h = h.replace(f'href="{current}">', f'href="{current}" aria-current="page">')
    t = t.replace('<!--SYMBOL-->', symbol).replace('<!--HEADER-->', h).replace('<!--FOOTER-->', footer)
    open(page, 'w').write(t)
    print(page, 'ok')
