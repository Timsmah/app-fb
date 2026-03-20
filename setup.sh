#!/usr/bin/env bash
# setup.sh — Download dependencies and generate icons

set -e

echo "📦 Creating folder structure..."
mkdir -p libs icons

echo "⬇️  Downloading jsPDF..."
curl -L -o libs/jspdf.umd.min.js \
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
echo "✅ jsPDF downloaded → libs/jspdf.umd.min.js"

echo "🎨 Generating icons..."
python3 - <<'PYEOF'
import struct, zlib, os

def make_png(size, r=24, g=119, b=242):
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))

    rows = b''
    for _ in range(size):
        rows += b'\x00' + bytes([r, g, b]) * size
    idat = chunk(b'IDAT', zlib.compress(rows))
    iend = chunk(b'IEND', b'')

    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend

os.makedirs('icons', exist_ok=True)
for s in [16, 48, 128]:
    with open(f'icons/icon{s}.png', 'wb') as f:
        f.write(make_png(s))
    print(f'  icon{s}.png created')
PYEOF

echo ""
echo "✅ Setup complete!"
echo ""
echo "👉 How to load the extension in Chrome:"
echo "   1. Open Chrome and go to: chrome://extensions"
echo "   2. Enable 'Developer mode' (top-right toggle)"
echo "   3. Click 'Load unpacked'"
echo "   4. Select this folder: $(pwd)"
echo ""
echo "   Then navigate to any:"
echo "   • facebook.com/marketplace/item/..."
echo "   • facebook.com/groups/..."
echo "   and click the blue 'Extract' button."
