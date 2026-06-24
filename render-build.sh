#!/usr/bin/env bash
set -o errexit

npm install

export PUPPETEER_CACHE_DIR=./chrome-cache
npx puppeteer browsers install chrome

# Download WhatsApp Web version file for local caching
mkdir -p ./wwebjs_version
curl -o ./wwebjs_version/2.2412.54.html https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html
