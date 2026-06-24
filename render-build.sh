#!/usr/bin/env bash
set -o errexit

# Install dependencies
npm install

# Create the cache directory for Puppeteer
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# Download Chrome into that directory
npx puppeteer browsers install chrome

# Log the installation path (helps to set PUPPETEER_EXECUTABLE_PATH)
ls -la $PUPPETEER_CACHE_DIR/chrome/linux-*/chrome-linux64/chrome
