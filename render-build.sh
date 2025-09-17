#!/usr/bin/env bash
set -euo pipefail

npm install --prefix dashboard-web
npm run build --prefix dashboard-web
