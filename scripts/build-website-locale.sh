#!/bin/sh
# Keep the public language entry to one request. Source dictionaries remain editable.
set -eu
locale_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
locale_target="$locale_root/website/assets/locale-site.js"
locale_temp=$(mktemp "$locale_root/website/assets/.locale-site.XXXXXX")
trap 'rm -f "$locale_temp"' EXIT HUP INT TERM
for locale_part in locale-pages-en.js locale-flow-en.js locale-gallery-en.js locale.js; do
  cat "$locale_root/website/assets/$locale_part" >> "$locale_temp"
  printf '\n;\n' >> "$locale_temp"
done
chmod 644 "$locale_temp"
mv "$locale_temp" "$locale_target"
