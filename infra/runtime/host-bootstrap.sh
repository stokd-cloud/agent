#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 ]] || exit 7
for command in docker curl systemctl flock mkfs.xfs blkid mountpoint findmnt ss; do
  command -v "$command" >/dev/null || { echo "pinned ECS AMI is missing ${command}; refusing boot-time installation" >&2; exit 7; }
done
# Registry authentication needs EITHER the ECR credential helper or the AWS CLI;
# agent_prepare_private_registry prefers the helper and falls back to an
# explicit login. Nothing is ever installed at boot.
command -v docker-credential-ecr-login >/dev/null || command -v aws >/dev/null || {
  echo 'pinned ECS AMI has neither docker-credential-ecr-login nor aws; refusing boot-time installation' >&2
  exit 7
}
[[ -f /etc/stokd-agent/host.env && "$(stat -c '%a:%u' /etc/stokd-agent/host.env)" == '400:0' ]] || exit 7
# shellcheck disable=SC1091
source /etc/stokd-agent/host.env
for script in host-common mongo-service migrate-host validation-seed-host backup-host restore-host; do
  [[ -x "/opt/stokd-agent/bin/$script" && "$(stat -c '%a:%u' "/opt/stokd-agent/bin/$script")" == '555:0' ]] || exit 7
done
systemctl daemon-reload
systemctl enable stokd-agent-mongo.service
if grep -Fxq 'AGENT_STAGE=source-val12' /etc/stokd-agent/host.env; then
  systemctl enable stokd-agent-backup.timer
  systemctl start stokd-agent-backup.timer
else
  systemctl disable stokd-agent-backup.timer >/dev/null 2>&1 || true
fi
systemctl start stokd-agent-mongo.service
/opt/stokd-agent/bin/migrate-host --operation-id "initial-${AGENT_STAGE}-v1" --target-stage "$AGENT_STAGE"
