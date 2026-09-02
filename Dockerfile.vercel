# Pin a release tag at Phase 1 (check https://github.com/pocket-id/pocket-id/releases). Alpine variant: has /bin/sh.
# Do NOT use -distroless (no shell → ENTRYPOINT below can't run). Do NOT use the image's entrypoint.sh
# (runs as root, adduser/mkdir /app/data/chown) — we bypass it and run as 1000 directly.
FROM ghcr.io/pocket-id/pocket-id:v2.14.0

ENV APP_ENV=production \
    PORT=1411 \
    ACTORS_HOST=127.0.0.1 \
    FILE_BACKEND=database \
    GEOLITE_DB_PATH=/tmp/GeoLite2-City.mmdb \
    TRUSTED_PLATFORM=X-Real-IP \
    ALLOW_INSECURE_CALLBACK_URLS=false \
    ANALYTICS_DISABLED=true \
    VERSION_CHECK_DISABLED=true \
    LOG_JSON=true

USER 1000:1000
EXPOSE 1411

# Neon injects DATABASE_URL_UNPOOLED; Pocket ID reads DB_CONNECTION_STRING.
# APP_URL must be the exact canonical origin (WebAuthn RP ID); derive from the project's production domain.
ENTRYPOINT ["sh","-c","export DB_CONNECTION_STRING=\"${DB_CONNECTION_STRING:-$DATABASE_URL_UNPOOLED}\" APP_URL=\"${APP_URL:-https://$VERCEL_PROJECT_PRODUCTION_URL}\"; exec /app/pocket-id"]
