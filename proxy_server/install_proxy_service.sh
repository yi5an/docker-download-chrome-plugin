#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
SCRIPT_DIR=""
PUBLIC_IP="${1:-}"
PORT="${2:-${PORT:-7001}}"
HOST="${HOST:-0.0.0.0}"
REGISTRY_SERVICE_URL="${REGISTRY_SERVICE_URL:-http://127.0.0.1:3000}"
USE_PROXY="${USE_PROXY:-false}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:7890}"
NODE_ID="${PROXY_NODE_ID:-proxy-$(hostname)-${PORT}}"
APP_NAME="${PM2_APP_NAME:-docker-download-proxy-${PORT}}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/docker-download-chrome-plugin}"
REPO_URL="${REPO_URL:-https://github.com/yi5an/docker-download-chrome-plugin.git}"
REPO_BRANCH="${REPO_BRANCH:-feat/proxy-registry-service}"

if [[ -n "${SCRIPT_SOURCE}" && "${SCRIPT_SOURCE}" != "bash" && "${SCRIPT_SOURCE}" != "-" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
fi

prompt_confirm() {
  local prompt_text="$1"
  local answer=""

  if [[ -t 0 ]]; then
    read -r -p "${prompt_text}" answer
  elif [[ -r /dev/tty ]]; then
    read -r -p "${prompt_text}" answer < /dev/tty
  else
    echo "Interactive confirmation is required, but no TTY is available."
    exit 1
  fi

  if [[ ! "${answer}" =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 1
  fi
}

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
echo "  Repo branch: ${REPO_BRANCH}"
echo
echo "Reminder:"
echo "  - Open TCP port ${PORT} in your cloud security group / firewall"
echo "  - The registry service will verify http://${PUBLIC_IP}:${PORT}/health during registration"
echo "  - If port ${PORT} is blocked, registration will timeout"

if [[ -z "${SCRIPT_DIR}" || ! -f "${SCRIPT_DIR}/service.js" ]]; then
  echo
  echo "Bootstrap mode detected. The installer will fetch the project into:"
  echo "  ${INSTALL_ROOT}"
  prompt_confirm "Continue downloading project files? [y/N] "

  if ! command -v git >/dev/null 2>&1; then
    echo "git is required for bootstrap mode. Please install git first."
    exit 1
  fi

  if [[ -d "${INSTALL_ROOT}/.git" ]]; then
    git -C "${INSTALL_ROOT}" fetch --all --prune
    git -C "${INSTALL_ROOT}" checkout "${REPO_BRANCH}"
    git -C "${INSTALL_ROOT}" pull --ff-only origin "${REPO_BRANCH}"
  else
    mkdir -p "$(dirname "${INSTALL_ROOT}")"
    git clone --branch "${REPO_BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_ROOT}"
  fi

  SCRIPT_DIR="${INSTALL_ROOT}/proxy_server"
fi

ENV_FILE="${SCRIPT_DIR}/.env.proxy-service"
LOG_FILE="${SCRIPT_DIR}/service-install.log"

cd "${SCRIPT_DIR}"

NEEDS_DEPS_INSTALL="true"
if [[ "${NEEDS_DEPS_INSTALL}" == "true" ]]; then
  echo
  echo "This installer needs to install runtime dependencies before continuing."
  echo "  - project dependencies refresh: npm install"
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "  - global process manager: npm install -g pm2"
  fi
  prompt_confirm "Continue installing dependencies? [y/N] "
fi

npm install

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
echo "Common cause: port ${PORT} is not open to the public internet, so registry validation cannot reach this node."
echo "Check your cloud security group / firewall, then verify:"
echo "  curl -I -m 10 http://${PUBLIC_IP}:${PORT}/health"
pm2 logs "${APP_NAME}" --lines 80 --nostream || true
exit 1
