#!/usr/bin/env bash
# Build da API Google Calendar em staging. NAO inicia/reinicia containers.
# Uso: bash infra/scripts/calendar-stage-image.sh <SHA40>
set -Eeuo pipefail
umask 077

if (( $# != 1 )); then
  echo "ERRO: sintaxe: script <SHA40>." >&2
  exit 2
fi
SHA="$1"
if [[ ! "$SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "ERRO: informe o SHA completo (40 caracteres)." >&2
  exit 2
fi

REPO="https://github.com/joadlsilvaseo-png/isabelenailsapp.git"
BRANCH="feat/calendar-cutover-fluxos-20261108"
SHORT="$(printf '%s' "$SHA" | cut -c1-12)"
STAGE="/opt/isabele-nails-releases/calendar-stage-$SHORT"
TAG="isabele-nails-api:calendar-stage-$SHORT"
API="isabele-infra-api-1"

command -v git >/dev/null
command -v docker >/dev/null
test "$(id -u)" = "0" || { echo "ERRO: executar como root na VPS." >&2; exit 1; }
docker inspect "$API" >/dev/null
BEFORE="$(docker inspect --format '{{.Image}}' "$API")"

# A imagem de build precisa de espaço. Se insuficiente, abortar sem tocar na API.
AVAILABLE="$(df -B1 --output=avail /opt | tail -n 1 | tr -d ' ')"
if (( AVAILABLE < 1610612736 )); then
  echo "BLOQUEADO: menos de 1,5 GiB livres em /opt." >&2
  exit 1
fi

if [[ -e "$STAGE" ]]; then
  if [[ ! -d "$STAGE/.git" ]]; then
    echo "BLOQUEADO: pasta de release existente sem checkout Git verificável." >&2
    exit 1
  fi
else
  # Nao aceita branch movida: clona e confirma SHA antes do build.
  GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$STAGE"
fi

ACTUAL="$(git -C "$STAGE" rev-parse HEAD)"
if [[ "$ACTUAL" != "$SHA" ]]; then
  echo "BLOQUEADO: checkout diferente do SHA aprovado." >&2
  exit 1
fi
if [[ -n "$(git -C "$STAGE" status --porcelain)" ]]; then
  echo "BLOQUEADO: checkout local com alterações não revisadas." >&2
  exit 1
fi
test -f "$STAGE/infra/backend/Dockerfile"
test -f "$STAGE/infra/backend/src/server.js"
test -f "$STAGE/infra/backend/scripts/calendarLegacyReview.mjs"

echo "=== BUILD API EM STAGING (sem deploy) ==="
echo "SHA: $SHA"
echo "Tag: $TAG"
docker build --build-arg "APP_REVISION=$SHA" \
  --tag "$TAG" \
  --file "$STAGE/infra/backend/Dockerfile" \
  "$STAGE/infra/backend"

LABEL="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$TAG")"
[[ "$LABEL" == "$SHA" ]] || {
  echo "ERRO: label da imagem não corresponde ao commit." >&2; exit 1;
}

echo "=== TESTES ESTATICOS DENTRO DA IMAGEM ==="
docker run --rm --network none --entrypoint node "$TAG" --check /app/src/server.js
docker run --rm --network none --entrypoint node "$TAG" --check /app/src/googleCalendarDirectBridge.js
docker run --rm --network none --entrypoint node "$TAG" --check /app/scripts/calendarLegacyReview.mjs

AFTER="$(docker inspect --format '{{.Image}}' "$API")"
[[ "$AFTER" == "$BEFORE" ]] || {
  echo "ALERTA: container da API foi alterado por outro processo." >&2; exit 1;
}
echo "IMAGEM_STAGING_OK"
echo "TAG=$TAG"
echo "CONTAINER_PRODUCAO_INALTERADO"
docker ps --filter "name=^/$API$" --format '{{.Names}} | {{.Image}} | {{.Status}}'
