#!/bin/bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: pipeline-tracker/scripts/release.sh <version>  (e.g. 1.0.1)"
  exit 1
fi

TAG="pt-v$VERSION"

# Bail if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists — aborting"
  exit 1
fi

echo "==> Updating manifest version to $VERSION"
node -e "
  const fs = require('fs');
  const path = 'pipeline-tracker/src/manifest.json';
  const m = JSON.parse(fs.readFileSync(path, 'utf8'));
  m.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
"

echo "==> Building"
pnpm build:pipeline-tracker

echo "==> Packing .crx"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension=pipeline-tracker/dist \
  --pack-extension-key=pipeline-tracker/.keys/pipeline-tracker.pem \
  2>/dev/null
mv pipeline-tracker/dist.crx pipeline-tracker/pipeline-tracker.crx

echo "==> Updating updates.xml"
CRX_URL="https://github.com/Blaze212/skool-automations/releases/download/${TAG}/pipeline-tracker.crx"
cat > pipeline-tracker/updates.xml <<EOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='elfbnnfdfipalinmngcnejkfdehelnjh'>
    <updatecheck
      codebase='${CRX_URL}'
      version='${VERSION}' />
  </app>
</gupdate>
EOF

echo "==> Committing and tagging"
git add pipeline-tracker/src/manifest.json pipeline-tracker/updates.xml
git commit -m "chore(pipeline-tracker): release v${VERSION}"
git tag "$TAG"
git push origin HEAD "$TAG"

echo "==> Creating GitHub release"
gh release create "$TAG" pipeline-tracker/pipeline-tracker.crx \
  --title "Pipeline Tracker v${VERSION}" \
  --notes ""

rm pipeline-tracker/pipeline-tracker.crx

echo ""
echo "Done. Chrome will auto-update clients within a few hours."
echo "To force an immediate check: chrome://extensions → Update extensions now"
