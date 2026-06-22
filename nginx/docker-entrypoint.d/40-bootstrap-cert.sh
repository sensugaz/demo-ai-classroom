#!/bin/sh
# Ensure a TLS cert exists where the nginx config expects it, so nginx can start
# even before you've dropped in your real certificate.
#
# Runs as part of the nginx image entrypoint (/docker-entrypoint.d/*). If
# /etc/nginx/certs is missing fullchain.pem / privkey.pem, it writes a throwaway
# self-signed placeholder (e.g. local dev on https://localhost). Replace it by
# mounting your real cert at ./nginx/certs.
set -e

CERT_DIR="/etc/nginx/certs"
DOMAIN="${SSL_DOMAIN:-localhost}"

if [ -f "${CERT_DIR}/tls.crt" ] && [ -f "${CERT_DIR}/tls.key" ]; then
    echo "[bootstrap-cert] cert present in ${CERT_DIR}"
    exit 0
fi

echo "[bootstrap-cert] no cert in ${CERT_DIR} — generating self-signed placeholder (CN=${DOMAIN})"
command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null 2>&1 || true
mkdir -p "${CERT_DIR}"
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "${CERT_DIR}/tls.key" \
    -out "${CERT_DIR}/tls.crt" \
    -subj "/CN=${DOMAIN}" >/dev/null 2>&1

echo "[bootstrap-cert] self-signed placeholder ready — replace with your real cert"
