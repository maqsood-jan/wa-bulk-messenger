#!/usr/bin/env bash
set -o errexit

# Install dependencies
npm install

# Set cache directory inside the project (will be deployed)
export PUPPETEER_CACHE_DIR=./chrome-cache

# Download Chrome into that directory
npx puppeteer browsers install chrome
