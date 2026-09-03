#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 1 ]] || { echo 'expected exactly one maintenance command' >&2; exit 2; }
case "$1" in backup|restore-offline|restore-finalize|readiness|migrate|validation-seed|validation-read) ;; *) echo 'unsupported maintenance command' >&2; exit 2 ;; esac
exec /usr/local/bin/node /opt/workspace/packages/storage/lib/maintenance-cli.js "$1"
