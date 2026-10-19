#!/usr/bin/env bash
set -euo pipefail
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
task_package="${1:-$task_dir/../homebridge-ledvance-native-1.0.0.tgz}"
if [[ ! -f "$task_package" ]]; then
  echo "Usage: bash install-local.sh /full/path/homebridge-ledvance-native-1.0.0.tgz" >&2
  exit 1
fi
if [[ $EUID -eq 0 ]]; then
  npm install -g --omit=dev "$task_package"
else
  sudo npm install -g --omit=dev "$task_package"
fi
echo "Installed. Add LEDVANCE Native in Homebridge settings, enter your app credentials and restart Homebridge."
