#!/bin/sh
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
cp ../index.html ../repondre.html ../upgrade.html ../upgrade-groupe.html ../space_panel_v2.js _headers dist/
cp -r ../assets ../templates dist/
