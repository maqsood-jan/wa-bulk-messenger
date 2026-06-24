#!/usr/bin/env bash
set -o errexit

# Install dependencies
npm install

# Set cache directory to project folder
export PUPPETEER_CACHE_DIR=./chrome-cache

# Download Chrome
npx puppeteer browsers install chrome

# Patch the problematic file to prevent crashes
PATCH_FILE="node_modules/whatsapp-web.js/src/webCache/LocalWebCache.js"
if [ -f "$PATCH_FILE" ]; then
	echo "Patching $PATCH_FILE ..."
	sed -i 's/const version = indexHtml\.match(\/manifest-([\\d\\\\.]+)\\.json\/)\[1\];/const match = indexHtml.match(\/manifest-([\\d\\\\.]+)\\.json\/); const version = match ? match[1] : "2.2412.54";/' "$PATCH_FILE"
	echo "Patch applied."
	else
		echo "Warning: $PATCH_FILE not found."
		fi
