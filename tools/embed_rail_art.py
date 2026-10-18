"""Embed local illustration layers into the page for zero-restart local previews."""
from pathlib import Path
import base64
import re

ROOT = Path(__file__).resolve().parents[1]
page = ROOT / 'web' / 'index.html'
text = page.read_text(encoding='utf-8')
for layer, filename in [('scene-landscape', 'railway-landscape.png'), ('scene-train', 'harmony-train-straight.png')]:
    encoded = base64.b64encode((ROOT / 'web' / 'art' / filename).read_bytes()).decode('ascii')
    pattern = r'(class="' + layer + r'" src=")[^"]*'
    text, count = re.subn(pattern, lambda match: match[1] + 'data:image/png;base64,' + encoded, text)
    if count != 1:
        raise ValueError('Expected one image layer: ' + layer)
page.write_text(text, encoding='utf-8')
