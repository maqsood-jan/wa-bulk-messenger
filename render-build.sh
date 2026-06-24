#!/usr/bin/env bash
set -o errexit

npm install
export PUPPETEER_CACHE_DIR=./chrome-cache
npx puppeteer browsers install chrome
