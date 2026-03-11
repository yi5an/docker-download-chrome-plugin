#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_IP="${1:-}"
PORT="${2:-${PORT:-7001}}"
HOST="${HOST:-0.0.0.0}"
REGISTRY_SERVICE_URL="${REGISTRY_SERVICE_URL:-http://127.0.0.1:3000}"
USE_PROXY="${USE_PROXY:-false}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"
NODE_ID="${PROXY_NODE_ID:-proxy-$(hostname)-${PORT}}"
ENV_FILE="${SCRIPT_DIR}/.env.proxy-service"
LOG_FILE="${SCRIPT_DIR}/service-install.log"
APP_NAME="${PM2_APP_NAME:-docker-download-proxy-${PORT}}"

detect_public_ip() {
  curl -fsS https://api.ipify.org 2>/dev/null || curl -fsS https://ifconfig.me 2>/dev/null || true
}

  if [[ -z "${PUBLIC_IP}" ]]; then
    PUBLIC_IP="$(detect_public_ip)"
  if [[ -z "${PUBLIC_IP}" ]]; then
    echo "Failed to detect public IP automatically. Please pass a public IP, for example:"
    echo "  ./install_proxy_service.sh 1.2.3.4 7001"
    exit 1
  fi
fi

if [[ "${PUBLIC_IP}" =~ :// ]]; then
  echo "Please pass only an IP address, not a full URL."
  exit 1
fi

if ! [[ "${PORT}" =~ ^[0-9]+$ ]]; then
  echo "Port must be a number."
  exit 1
fi

PUBLIC_BASE_URL="http://${PUBLIC_IP}:${PORT}"

echo "Installing proxy service"
echo "  Registry service: ${REGISTRY_SERVICE_URL}"
echo "  Public IP: ${PUBLIC_IP}"
echo "  Public base URL: ${PUBLIC_BASE_URL}"
echo "  Port: ${PORT}"
echo "  Upstream proxy enabled: ${USE_PROXY}"

cd "${SCRIPT_DIR}"

NEEDS_DEPS_INSTALL="false"
if [[ ! -d node_modules ]]; then
  NEEDS_DEPS_INSTALL="true"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  NEEDS_DEPS_INSTALL="true"
fi

if [[ "${NEEDS_DEPS_INSTALL}" == "true" ]]; then
  echo
  echo "This installer needs to install runtime dependencies before continuing."
  echo "  - project dependencies: npm install"
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "  - global process manager: npm install -g pm2"
  fi
  read -r -p "Continue installing dependencies? [y/N] " CONFIRM_INSTALL
  if [[ ! "${CONFIRM_INSTALL}" =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 1
  fi
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HOST=${HOST}
REGISTRY_SERVICE_URL=${REGISTRY_SERVICE_URL}
PROXY_NODE_ID=${NODE_ID}
PROXY_PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
USE_PROXY=${USE_PROXY}
PROXY_URL=${PROXY_URL}
EOF

set -a
source "${ENV_FILE}"
set +a

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  echo "Restarting existing pm2 app: ${APP_NAME}"
  pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true
fi

echo "Starting proxy service with pm2 app name: ${APP_NAME}"
pm2 start service.js \
  --name "${APP_NAME}" \
  --node-args="--max-old-space-size=512" \
  --merge-logs \
  --time \
  --update-env >/dev/null

echo "Waiting for pm2-managed service registration to succeed..."

for _ in $(seq 1 20); do
  if ! pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
    echo "Proxy service is not present in pm2. Recent logs:"
    pm2 logs "${APP_NAME}" --lines 80 --nostream || true
    exit 1
  fi

  APP_STATUS="$(pm2 jlist | node -e "let raw='';process.stdin.on('data',d=>raw+=d).on('end',()=>{const apps=JSON.parse(raw||'[]');const app=apps.find(item=>item.name===process.argv[1]);process.stdout.write(app?.pm2_env?.status||'missing');});" "${APP_NAME}")"
  if [[ "${APP_STATUS}" != "online" && "${APP_STATUS}" != "launching" ]]; then
    echo "Proxy service exited during startup. Recent log:"
    pm2 logs "${APP_NAME}" --lines 80 --nostream || true
    exit 1
  fi

  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "Proxy service started successfully."
    echo "  Health: http://127.0.0.1:${PORT}/health"
    echo "  PM2 app: ${APP_NAME}"
    echo "  Logs: pm2 logs ${APP_NAME}"
    pm2 save >/dev/null 2>&1 || true
    exit 0
  fi

  sleep 1
done

echo "Proxy service did not become healthy in time. Recent log:"
pm2 logs "${APP_NAME}" --lines 80 --nostream || true
exit 1
