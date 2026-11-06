#!/usr/bin/env bash
# Backup conservador anterior a grade nativa de 15 min.
# Apenas comandos de leitura dos containers e do banco; salva cópias privadas.
set -Eeuo pipefail
umask 077
MODE="$(printf '%s' "$@")"
[[ -n "$MODE" ]] || MODE="check"
APP_DIR="/opt/isabele-nails"
PG_CONTAINER="isabele-infra-postgres-1"
API_CONTAINER="isabele-infra-api-1"
DEST_ROOT="/root/backups-isabele"
EXPECTED_SHA="94809f76f9cb9d7f4b2b39d802bf46c281830993"
EXPECTED_IMAGE="isabele-nails-api:release-94809f76f9cb9d7f4b2b39d802bf46c281830993"

[[ "$MODE" == "check" || "$MODE" == "create" ]] || { echo "Uso: sudo bash backup-pre-grade-15.sh [check|create]" >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo "Execute como root" >&2; exit 2; }
[[ -d "$APP_DIR/.git" ]] || { echo "Diretório da API não encontrado" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker ausente" >&2; exit 1; }
# O checkout local pode estar em uma branch antiga e ter mudanças pendentes.
# Ele é apenas informativo. O backup protege a IMAGEM que realmente está
# rodando no container, sem alterar arquivos locais ou o Git.
CURRENT_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
for item in "$API_CONTAINER" "$PG_CONTAINER"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$item")" == "true" ]] ||
    { echo "ABORTADO: container não está executando: $item" >&2; exit 1; }
done
IMAGE_ID="$(docker inspect -f '{{.Image}}' "$API_CONTAINER")"
IMAGE_TAG="$(docker inspect -f '{{.Config.Image}}' "$API_CONTAINER")"
if [[ "$IMAGE_TAG" != "$EXPECTED_IMAGE" ]]; then
  printf 'ABORTADO: a API ativa usa %s, mas o backup exige %s.\n' "$IMAGE_TAG" "$EXPECTED_IMAGE" >&2
  exit 1
fi
if [[ "$CURRENT_SHA" != "$EXPECTED_SHA" ]]; then
  printf 'AVISO: o checkout local (%s) é diferente da API ativa.\n' "$CURRENT_SHA"
  echo "O Git e os arquivos locais não serão modificados."
fi
printf 'Preflight OK. Imagem ATIVA: %s\nID: %s\n' "$IMAGE_TAG" "$IMAGE_ID"
if [[ "$MODE" == "check" ]]; then
  echo "Modo check: nenhum backup foi feito."
  echo "Para criar: sudo bash backup-pre-grade-15.sh create"
  exit 0
fi

mkdir -p "$DEST_ROOT"
chmod 700 "$DEST_ROOT"
# Reserva uma margem de segurança para evitar lotar o disco da VPS.
IMAGE_BYTES="$(docker image inspect -f '{{.Size}}' "$IMAGE_ID")"
DB_BYTES="$(docker exec -i "$PG_CONTAINER" psql -U isabele_admin -d isabele_nails -Atqc 'SELECT pg_database_size(current_database())')"
FREE_BYTES="$(df -B1 --output=avail "$DEST_ROOT" | tail -n 1 | tr -d '[:space:]')"
[[ "$IMAGE_BYTES" =~ ^[0-9]+$ && "$DB_BYTES" =~ ^[0-9]+$ && "$FREE_BYTES" =~ ^[0-9]+$ ]] ||
  { echo "Não foi possível estimar o espaço; backup abortado." >&2; exit 1; }
REQUIRED_BYTES="$((IMAGE_BYTES + DB_BYTES * 2 + 1073741824))"
if (( FREE_BYTES < REQUIRED_BYTES )); then
  printf 'ABORTADO: espaço livre insuficiente (%s bytes); mínimo estimado %s.\n' "$FREE_BYTES" "$REQUIRED_BYTES" >&2
  exit 1
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$DEST_ROOT/pre-grade-15-$STAMP"
mkdir -m 700 "$DEST"
printf 'Git: %s\nImagem: %s\nID: %s\nUTC: %s\n' \
  "$CURRENT_SHA" "$IMAGE_TAG" "$IMAGE_ID" "$STAMP" > "$DEST/manifesto.txt"
# Leitura: imagem Docker antiga, sem rebuild nem restart.
docker image save -o "$DEST/imagem-api.tar" "$IMAGE_ID"
tar -tf "$DEST/imagem-api.tar" >/dev/null
# Snapshot consistente do PG; não bloqueia os atendimentos.
docker exec -i "$PG_CONTAINER" pg_dump -U isabele_admin -d isabele_nails -Fc \
  > "$DEST/postgresql-isabele-nails.dump"
# Verificação de legibilidade do dump, sem restauração no banco real.
docker exec -i "$PG_CONTAINER" pg_restore --list \
  < "$DEST/postgresql-isabele-nails.dump" > "$DEST/indice-pg-restore.txt"
for file in imagem-api.tar postgresql-isabele-nails.dump indice-pg-restore.txt; do
  [[ -s "$DEST/$file" ]] || { echo "BACKUP INCOMPLETO: $file" >&2; exit 1; }
done
(cd "$DEST" && sha256sum imagem-api.tar postgresql-isabele-nails.dump indice-pg-restore.txt > SHA256SUMS)
(cd "$DEST" && sha256sum -c SHA256SUMS)
printf 'BACKUP LOCAL VERIFICADO: %s\n' "$DEST"
echo "Restauração em banco isolado ainda é necessária para validação completa."
echo "Mantenha os arquivos em diretório privado; jamais envie dump ou imagem ao GitHub."
