#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Atualizacao incremental PIX: preserva a configuracao efetiva do Compose.
# O script nao acessa contas externas, nao cria cobrancas e nao habilita producao.

BRANCH="${BRANCH:-codex/correcao-pix-20261010}"
APP_DIR="${APP_DIR:-/opt/isabele-nails}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/isabele-nails-backups}"
RELEASE_ROOT="${RELEASE_ROOT:-/opt/isabele-nails-releases}"
LOG_DIR="${LOG_DIR:-/var/log/isabele-nails-deploy}"
MODE="${1:-apply}"
SCRIPT_PATH="$(readlink -f "$0")"

timestamp() { date -u +%Y%m%dT%H%M%SZ; }
die() { echo "ERRO: $*" >&2; exit 1; }

if [[ "$MODE" == "start" || "$MODE" == "--background" ]]; then
  mkdir -p "$LOG_DIR"
  chmod 750 "$LOG_DIR"
  LOG_FILE="${LOG_FILE:-$LOG_DIR/pix-update-$(timestamp).log}"
  export LOG_FILE APP_DIR BACKUP_ROOT RELEASE_ROOT LOG_DIR BRANCH
  nohup bash "$SCRIPT_PATH" apply >>"$LOG_FILE" 2>&1 </dev/null &
  echo "Atualizacao iniciada em segundo plano. PID=$!"
  echo "Log persistente: $LOG_FILE"
  exit 0
fi

mkdir -p "$LOG_DIR" "$BACKUP_ROOT"
chmod 750 "$LOG_DIR" "$BACKUP_ROOT"
LOG_FILE="${LOG_FILE:-$LOG_DIR/pix-update-$(timestamp).log}"
export LOG_FILE APP_DIR BACKUP_ROOT RELEASE_ROOT LOG_DIR BRANCH
exec >>"$LOG_FILE" 2>&1

LOCK_FILE="$LOG_DIR/pix-update.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "Ja existe uma atualizacao PIX em andamento. Consulte $LOG_DIR."

[[ "$EUID" -eq 0 ]] || die "Execute como root para ler a configuracao ativa e preservar os arquivos/segredos."
command -v docker >/dev/null || die "Docker nao encontrado."
command -v python3 >/dev/null || die "Python 3 nao encontrado."
command -v flock >/dev/null || die "flock nao encontrado."
command -v git >/dev/null || die "Git nao encontrado."
command -v curl >/dev/null || die "curl nao encontrado para o healthcheck."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 nao encontrado."

if [[ "$MODE" == "rollback" ]]; then
  [[ $# -ge 2 ]] || die "Uso: $SCRIPT_PATH rollback /caminho/do/backup"
  BACKUP_DIR="$2"
  [[ -d "$BACKUP_DIR" && -s "$BACKUP_DIR/effective-before.yaml" && -s "$BACKUP_DIR/old-api-image-id" ]] || die "Backup incompleto: $BACKUP_DIR"
  PROJECT_NAME="$(<"$BACKUP_DIR/compose-project")"
  API_SERVICE="$(<"$BACKUP_DIR/api-service")"
  PROJECT_WORKDIR="$(<"$BACKUP_DIR/compose-working-dir")"
  OLD_IMAGE_ID="$(<"$BACKUP_DIR/old-api-image-id")"
  [[ "$OLD_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Imagem anterior invalida."
  OLD_IMAGE_REF_FILE="$BACKUP_DIR/old-api-image-tag"
  if [[ -s "$OLD_IMAGE_REF_FILE" ]]; then
    OLD_IMAGE_REF="$(<"$OLD_IMAGE_REF_FILE")"
    if ! docker image inspect "$OLD_IMAGE_REF" >/dev/null 2>&1; then
      docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>&1 || die "Tag e imagem antiga ausentes; rollback indisponivel com este backup."
      docker image tag "$OLD_IMAGE_ID" "$OLD_IMAGE_REF"
    fi
  else
    # Compatibility for backups made before persistent rollback tags existed.
    docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>&1 || die "Imagem antiga nao esta mais no cache local e este backup nao possui tag persistente."
    OLD_IMAGE_REF="isabele-nails-api:rollback-recovered-$(timestamp)"
    docker image tag "$OLD_IMAGE_ID" "$OLD_IMAGE_REF"
    printf '%s\n' "$OLD_IMAGE_REF" >"$OLD_IMAGE_REF_FILE"
    chmod 600 "$OLD_IMAGE_REF_FILE"
  fi
  docker image inspect "$OLD_IMAGE_REF" >/dev/null 2>&1 || die "Referencia persistente da imagem antiga nao encontrada: $OLD_IMAGE_REF"
  ROLLBACK_OVERRIDE="$BACKUP_DIR/rollback-compose.yaml"
  cat >"$ROLLBACK_OVERRIDE" <<EOF
services:
  $API_SERVICE:
    image: "$OLD_IMAGE_REF"
    build: null
EOF
  chmod 600 "$ROLLBACK_OVERRIDE"
  docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
    --file "$BACKUP_DIR/effective-before.yaml" --file "$ROLLBACK_OVERRIDE" \
    up -d --no-deps "$API_SERVICE"
  echo "Rollback do backend e da configuracao efetiva Compose concluido."
  echo "A migracao 010 e os dados foram preservados; nenhum dump foi restaurado."
  exit 0
fi

# Localiza o projeto/container em execucao sem assumir arquivos Compose. As labels
# do container registram o projeto, diretorio de trabalho e todos os -f usados.
[[ -d "$APP_DIR" ]] || die "APP_DIR nao existe: $APP_DIR"
APP_REAL="$(realpath "$APP_DIR")"
mapfile -t ALL_API_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.service=api")
API_CONTAINERS=()
for candidate in "${ALL_API_CONTAINERS[@]}"; do
  candidate_files="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$candidate")"
  candidate_workdir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$candidate")"
  IFS=',' read -r -a candidate_file_list <<<"$candidate_files"
  for candidate_file in "${candidate_file_list[@]}"; do
    candidate_real="$(realpath "$candidate_file" 2>/dev/null || realpath "$candidate_workdir/$candidate_file" 2>/dev/null || realpath "$APP_REAL/$candidate_file" 2>/dev/null || true)"
    if [[ "$candidate_real" == "$APP_REAL/infra/compose.yaml" ]]; then
      API_CONTAINERS+=("$candidate")
      break
    fi
  done
done
[[ "${#API_CONTAINERS[@]}" -eq 1 ]] || die "Esperava um container api ativo usando $APP_REAL/infra/compose.yaml; encontrados ${#API_CONTAINERS[@]}. Nenhuma alteracao foi feita."
API_CONTAINER="${API_CONTAINERS[0]}"
PROJECT_NAME="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$API_CONTAINER")"
API_SERVICE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$API_CONTAINER")"
PROJECT_WORKDIR="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$API_CONTAINER")"
CONFIG_FILES_LABEL="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$API_CONTAINER")"
[[ -n "$PROJECT_NAME" && "$PROJECT_NAME" != "<no value>" ]] || die "Container sem label de projeto Compose."
[[ "$API_SERVICE" == "api" ]] || die "Servico ativo inesperado: $API_SERVICE"
[[ -n "$PROJECT_WORKDIR" && "$PROJECT_WORKDIR" != "<no value>" ]] || die "Container sem diretorio Compose registrado."
[[ -n "$CONFIG_FILES_LABEL" && "$CONFIG_FILES_LABEL" != "<no value>" ]] || die "Docker nao informou os arquivos Compose originais; cancelando para nao substituir configuracao."

IFS=',' read -r -a ORIGINAL_COMPOSE_FILES <<<"$CONFIG_FILES_LABEL"
[[ "${#ORIGINAL_COMPOSE_FILES[@]}" -ge 1 ]] || die "Nao foi possivel ler a lista de arquivos Compose ativos."
for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
  [[ -f "$file" ]] || die "Arquivo Compose ativo ausente: $file"
done

# Estes caminhos sao conhecidos nesta instalacao. Se estiverem presentes, devem
# constar nas labels do container; assim um override nao passa despercebido.
for expected in \
  "$APP_DIR/infra/compose.yaml" \
  "$APP_DIR/infra/compose.override.yaml" \
  "/root/isabele-codex-pix-teste-20261010-125718.compose.yaml"; do
  if [[ -f "$expected" ]]; then
    found=false
    for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
      file_real="$(realpath "$file" 2>/dev/null || realpath "$PROJECT_WORKDIR/$file" 2>/dev/null || realpath "$APP_REAL/$file" 2>/dev/null || true)"
      [[ "$file_real" == "$(realpath "$expected")" ]] && found=true
    done
    [[ "$found" == true ]] || die "O arquivo Compose existente nao aparece na configuracao ativa: $expected"
  fi
done

mapfile -t PROJECT_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME")
[[ "${#PROJECT_CONTAINERS[@]}" -gt 0 ]] || die "Nenhum container ativo no projeto $PROJECT_NAME."
mapfile -t DB_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter "label=com.docker.compose.service=postgres")
[[ "${#DB_CONTAINERS[@]}" -eq 1 ]] || die "Esperava um PostgreSQL ativo no projeto; encontrados ${#DB_CONTAINERS[@]}. Nenhuma alteracao foi feita."
DB_CONTAINER="${DB_CONTAINERS[0]}"
DB_SERVICE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$DB_CONTAINER")"

[[ "$MODE" == "apply" ]] || die "Modo invalido. Use start, apply ou rollback."

git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "APP_DIR nao e o checkout Git do projeto."
REMOTE_URL="$(git -C "$APP_DIR" remote get-url origin)"
case "${REMOTE_URL,,}" in
  *joadlsilvaseo-png/isabelenailsapp.git|*joadlsilvaseo-png/isabelenailsapp) ;;
  *) die "O origin de APP_DIR nao e joadlsilvaseo-png/isabelenailsapp." ;;
esac

cd "$APP_DIR"
echo "Inicio: $(date -Is)"
echo "Branch alvo: $BRANCH"
echo "Projeto Compose ativo: $PROJECT_NAME"
echo "Arquivos Compose ativos: ${ORIGINAL_COMPOSE_FILES[*]}"
echo "Servico ativo: $API_SERVICE; checkout local sera preservado."
echo "Log persistente: $LOG_FILE"

# A configuracao efetiva resolvida e armazenada protegida: pode conter tokens,
# senhas, VAPID e caminhos/credenciais Firebase. Nunca e impressa no log.
BACKUP_DIR="$BACKUP_ROOT/pix-update-$(timestamp)-$$"
mkdir -m 700 "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
printf '%s\n' "$PROJECT_NAME" >"$BACKUP_DIR/compose-project"
printf '%s\n' "$API_SERVICE" >"$BACKUP_DIR/api-service"
printf '%s\n' "$PROJECT_WORKDIR" >"$BACKUP_DIR/compose-working-dir"
printf '%s\n' "$CONFIG_FILES_LABEL" >"$BACKUP_DIR/compose-files-label"
mkdir -m 700 "$BACKUP_DIR/compose-sources"
: >"$BACKUP_DIR/compose-source-manifest.txt"
index=0
for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
  index=$((index + 1))
  copy_name="$(printf '%02d' "$index")-$(basename "$file")"
  cp -- "$file" "$BACKUP_DIR/compose-sources/$copy_name"
  chmod 600 "$BACKUP_DIR/compose-sources/$copy_name"
  printf '%s\t%s\n' "$file" "$copy_name" >>"$BACKUP_DIR/compose-source-manifest.txt"
done

docker inspect "$API_CONTAINER" >"$BACKUP_DIR/api-container-before.json"
docker inspect "${PROJECT_CONTAINERS[@]}" >"$BACKUP_DIR/project-containers-before.json"
chmod 600 "$BACKUP_DIR/compose-source-manifest.txt" "$BACKUP_DIR/api-container-before.json" "$BACKUP_DIR/project-containers-before.json"

render_effective_compose() {
  local format="$1"
  python3 - "$BACKUP_DIR/project-containers-before.json" "$API_CONTAINER" "$PROJECT_WORKDIR" "$PROJECT_NAME" "$format" "${ORIGINAL_COMPOSE_FILES[@]}" <<'PY'
import json, os, subprocess, sys
inspect_path, api_id, workdir, project, fmt, *files = sys.argv[1:]
with open(inspect_path, encoding="utf-8") as f: containers = json.load(f)
env = os.environ.copy()
api_env = {}
for container in containers:
    values = {}
    for item in container.get("Config", {}).get("Env", []) or []:
        key, sep, value = item.partition("=")
        if sep: values[key] = value
    if container.get("Id", "").startswith(api_id): api_env = values
    else:
        for key, value in values.items(): env.setdefault(key, value)
env.update(api_env)
cmd = ["docker", "compose", "--project-directory", workdir, "--project-name", project]
for path in files: cmd.extend(["--file", path])
cmd.append("config")
if fmt == "json": cmd.extend(["--format", "json"])
result = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
if result.returncode:
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)
sys.stdout.write(result.stdout)
PY
}

render_effective_compose yaml >"$BACKUP_DIR/effective-before.yaml"
render_effective_compose json >"$BACKUP_DIR/effective-before.json"
[[ -s "$BACKUP_DIR/effective-before.yaml" && -s "$BACKUP_DIR/effective-before.json" ]] || die "Snapshot da configuracao Compose vazio."
chmod 600 "$BACKUP_DIR"/effective-before.*

# A renderizacao precisa refletir exatamente o processo ativo. O script aborta
# antes de parar servicos se qualquer env, credencial ou volume nao corresponder.
python3 - "$BACKUP_DIR/effective-before.json" "$BACKUP_DIR/api-container-before.json" "$PROJECT_NAME" <<'PY'
import json, os, sys
config_path, inspect_path, project = sys.argv[1:]
with open(config_path, encoding="utf-8") as f: config = json.load(f)
with open(inspect_path, encoding="utf-8") as f: container = json.load(f)[0]
service = config.get("services", {}).get("api")
if not service:
    raise SystemExit("Configuracao renderizada nao contem o servico api.")
raw = service.get("environment") or {}
if isinstance(raw, list):
    env_cfg = dict(item.split("=", 1) if "=" in item else (item, None) for item in raw)
else:
    env_cfg = raw
live_env = {}
for item in container.get("Config", {}).get("Env", []) or []:
    key, sep, value = item.partition("=")
    if sep: live_env[key] = value
mismatches = []
for key, value in env_cfg.items():
    # Cada variável declarada no Compose efetivo antigo precisa corresponder
    # exatamente ao container em execução. Chaves sem valor só são aceitas se
    # também estiverem ausentes no container.
    if value is None:
        if key in live_env:
            mismatches.append(key)
    elif key not in live_env or live_env[key] != str(value):
        mismatches.append(key)
if mismatches:
    names = ", ".join(sorted(set(mismatches)))
    raise SystemExit("Configuracao Compose nao corresponde ao container ativo (variaveis: " + names + "). Abortando sem alteracoes.")

# O commit 844398b antecede os novos flags/segredos de webhook. Eles não são
# exigidos nem injetados: a implementação alvo usa test quando MP_ENVIRONMENT
# está ausente e só habilita produção com PIX_PRODUCTION_ORDERS_ENABLED="true".
if live_env.get("MP_ENVIRONMENT", "test").strip().lower() != "test":
    raise SystemExit("O backend ativo nao esta em ambiente test; abortando sem alteracoes.")
if live_env.get("PIX_PRODUCTION_ORDERS_ENABLED", "").strip().lower() == "true":
    raise SystemExit("PIX de producao esta ativo na configuracao efetiva; abortando sem alteracoes.")

# Confere mounts bind (Firebase/segredos e demais arquivos) e os destinos/tipos
# de todos os volumes com o container atual.
configured = []
for item in service.get("volumes", []) or []:
    if isinstance(item, str):
        parts = item.rsplit(":", 2)
        if len(parts) == 1:
            source, target, mode = "", parts[0], ""
        elif len(parts) == 2:
            source, target, mode = parts[0], parts[1], ""
        else:
            source, target, mode = parts
        typ = "bind" if source.startswith("/") or source.startswith(".") else "volume"
        ro = any("ro" in m.split(",") for m in mode)
    else:
        typ = item.get("type", "volume")
        source = item.get("source", "")
        target = item.get("target", "")
        ro = bool(item.get("read_only", False))
    if typ == "bind":
        source = os.path.realpath(source)
    elif typ == "volume" and source:
        volume = (config.get("volumes", {}) or {}).get(source, {}) or {}
        resolved_name = volume.get("name") or (source if volume.get("external") else f"{project}_{source}")
        source = resolved_name
    configured.append((target, typ, source, ro))
live = []
for item in container.get("Mounts", []) or []:
    typ = item.get("Type", "")
    source = os.path.realpath(item.get("Source", "")) if typ == "bind" else item.get("Name", "") if typ == "volume" else ""
    live.append((item.get("Destination", ""), typ, source, not bool(item.get("RW", True))))
if sorted(configured) != sorted(live):
    raise SystemExit("Volumes do Compose renderizado diferem dos mounts ativos. Abortando sem alteracoes.")
print("Configuracao efetiva conferida: variaveis declaradas e mounts iguais ao container ativo; ambiente test e producao desativada.")
PY

# Salva status/diff e arquivos nao rastreados; nada e limpo nem sobrescrito.
git -C "$APP_DIR" fetch --no-tags origin "$BRANCH"
TARGET_COMMIT="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Nao foi possivel resolver o commit remoto."
printf '%s\n' "$TARGET_COMMIT" >"$BACKUP_DIR/target-commit"
printf '%s\n' "$(git -C "$APP_DIR" rev-parse HEAD)" >"$BACKUP_DIR/checkout-head"
git -C "$APP_DIR" status --porcelain=v1 >"$BACKUP_DIR/git-status.txt"
git -C "$APP_DIR" diff --binary HEAD >"$BACKUP_DIR/working-tree.patch"
git -C "$APP_DIR" ls-files --others --exclude-standard -z >"$BACKUP_DIR/untracked-files.list"
if [[ -s "$BACKUP_DIR/untracked-files.list" ]]; then
  tar -C "$APP_DIR" --null -T "$BACKUP_DIR/untracked-files.list" -czf "$BACKUP_DIR/untracked-files.tar.gz"
fi
find "$BACKUP_DIR" -maxdepth 1 -type f -exec chmod 600 {} +

API_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_CONTAINER")"
[[ "$API_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Imagem ativa da API nao identificada."
printf '%s\n' "$API_IMAGE_ID" >"$BACKUP_DIR/old-api-image-id"
OLD_API_IMAGE_TAG="isabele-nails-api:rollback-$(timestamp)-$$"
docker image tag "$API_IMAGE_ID" "$OLD_API_IMAGE_TAG"
[[ "$(docker image inspect --format '{{.Id}}' "$OLD_API_IMAGE_TAG")" == "$API_IMAGE_ID" ]] || die "Nao foi possivel criar referencia persistente para a imagem anterior."
printf '%s\n' "$OLD_API_IMAGE_TAG" >"$BACKUP_DIR/old-api-image-tag"
chmod 600 "$BACKUP_DIR/old-api-image-id" "$BACKUP_DIR/old-api-image-tag"

RELEASE_DIR="$RELEASE_ROOT/$TARGET_COMMIT"
[[ ! -e "$RELEASE_DIR" ]] || die "Release ja existe: $RELEASE_DIR"
mkdir -p "$RELEASE_ROOT"
git -C "$APP_DIR" worktree add --detach "$RELEASE_DIR" "$TARGET_COMMIT"
MIGRATION="$RELEASE_DIR/infra/migrations/010_pix_webhook_ambientes.sql"
[[ -f "$MIGRATION" ]] || die "Migracao 010 nao encontrada no commit alvo."

UPDATE_OVERRIDE="$BACKUP_DIR/update-compose.yaml"
TARGET_IMAGE_TAG="isabele-nails-api:release-${TARGET_COMMIT}"
printf '%s\n' "$TARGET_IMAGE_TAG" >"$BACKUP_DIR/target-api-image-tag"
cat >"$UPDATE_OVERRIDE" <<EOF
services:
  $API_SERVICE:
    image: "$TARGET_IMAGE_TAG"
    build:
      context: "$RELEASE_DIR/infra/backend"
      dockerfile: Dockerfile
      args:
        APP_REVISION: "$TARGET_COMMIT"
    labels:
      org.opencontainers.image.revision: "$TARGET_COMMIT"
EOF
chmod 600 "$UPDATE_OVERRIDE"

compose_snapshot() {
  docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
    --file "$BACKUP_DIR/effective-before.yaml" --file "$UPDATE_OVERRIDE" "$@"
}

# A migration 010 pode já ter sido aplicada por uma tentativa anterior. Detecta
# a estrutura final no catálogo PostgreSQL e só aplica se a estrutura ainda for
# a versão pré-010. Estado parcial é ambíguo e interrompe a atualização.
MIGRATION_STATE_SQL="$BACKUP_DIR/migration-010-state.sql"
cat >"$MIGRATION_STATE_SQL" <<'SQL'
WITH state AS (
  SELECT
    to_regclass('public.pix_webhook_inbox') IS NOT NULL AS has_table,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_webhook_inbox'
        AND column_name = 'mp_environment'
    ) AS has_environment_column,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_webhook_inbox'
        AND column_name = 'mp_environment' AND is_nullable = 'NO'
    ) AS environment_column_not_null,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_webhook_inbox'
        AND column_name = 'mp_environment' AND column_default = '''test''::text'
    ) AS environment_default_test,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.pix_webhook_inbox')
        AND conname = 'pix_webhook_inbox_environment_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%test%'
        AND pg_get_constraintdef(oid) LIKE '%production%'
    ) AS has_environment_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.pix_webhook_inbox')
        AND conname = 'pix_webhook_inbox_pkey' AND contype = 'p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (mp_environment, mp_order_id)'
    ) AS has_environment_primary_key,
    EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.idx_pix_webhook_pendentes')
        AND i.indisvalid
        AND pg_get_indexdef(i.indexrelid) LIKE '%(mp_environment, proxima_tentativa_em)%'
        AND pg_get_expr(i.indpred, i.indrelid) = '(processado_em IS NULL)'
    ) AS has_environment_pending_index
)
SELECT CASE
  WHEN NOT has_table THEN 'missing_table'
  WHEN has_environment_column AND environment_column_not_null AND environment_default_test AND has_environment_check
    AND has_environment_primary_key AND has_environment_pending_index THEN 'applied'
  WHEN NOT has_environment_column AND NOT has_environment_check THEN 'pending'
  ELSE 'partial'
END
FROM state;
SQL
chmod 600 "$MIGRATION_STATE_SQL"
MIGRATION_STATE="$(compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <"$MIGRATION_STATE_SQL" | tr -d '\r\n')"
case "$MIGRATION_STATE" in
  applied) echo "Migracao 010 ja aplicada; sera preservada sem nova execucao." ;;
  pending) echo "Migracao 010 ainda pendente; sera aplicada uma vez nesta atualizacao." ;;
  partial) die "Estado parcial da migracao 010; nenhuma migracao foi executada e a API nao sera parada." ;;
  missing_table) die "Tabela da migracao 008 ausente; nao e seguro aplicar a migracao 010." ;;
  *) die "Nao foi possivel determinar o estado da migracao 010 (resultado: $MIGRATION_STATE)." ;;
esac

printf '%s\n' "$DB_CONTAINER" >"$BACKUP_DIR/db-container-id"
compose_snapshot exec -T "$DB_SERVICE" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$BACKUP_DIR/postgres-before.dump"
[[ -s "$BACKUP_DIR/postgres-before.dump" ]] || die "Backup PostgreSQL vazio; atualizacao cancelada."
chmod 600 "$BACKUP_DIR/postgres-before.dump"
echo "Backup PostgreSQL concluido ($(du -h "$BACKUP_DIR/postgres-before.dump" | awk '{print $1}'))."
echo "Backup protegido: $BACKUP_DIR"
echo "Commit alvo: $TARGET_COMMIT"
echo "Imagem alvo: $TARGET_IMAGE_TAG"
echo "Configuracao de teste e volumes efetivos foram preservados; PIX real segue desativado."

compose_snapshot build "$API_SERVICE"
[[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$TARGET_IMAGE_TAG" 2>/dev/null || true)" == "$TARGET_COMMIT" ]] || die "A imagem versionada nao foi construida com o commit alvo."
API_STOPPED=false
MIGRATION_APPLIED=false
NEW_API_STARTED=false
restore_old_api_on_error() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    echo "Falha (codigo $rc); iniciando recuperacao segura."
    if [[ "$NEW_API_STARTED" == true ]]; then
      local rollback="$BACKUP_DIR/rollback-compose.yaml"
      local old_image="$(<"$BACKUP_DIR/old-api-image-tag")"
      cat >"$rollback" <<EOF
services:
  $API_SERVICE:
    image: "$old_image"
    build: null
EOF
      chmod 600 "$rollback"
      docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
        --file "$BACKUP_DIR/effective-before.yaml" --file "$rollback" \
        up -d --no-deps "$API_SERVICE" || true
    elif [[ "$API_STOPPED" == true ]]; then
      docker start "$API_CONTAINER" >/dev/null || true
    fi
    if [[ "$MIGRATION_APPLIED" == true || "$MIGRATION_STATE" == applied ]]; then
      echo "Migracao 010 aplicada e preservada; nenhum dado foi removido."
    fi
    echo "Backup e configuracao efetiva anterior: $BACKUP_DIR"
  fi
  exit "$rc"
}
trap restore_old_api_on_error EXIT

compose_snapshot stop "$API_SERVICE"
API_STOPPED=true
if [[ "$MIGRATION_STATE" == pending ]]; then
  compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION"
  MIGRATION_APPLIED=true
else
  echo "Pulando migracao 010 ja aplicada; banco e dados serao mantidos."
fi
NEW_API_STARTED=true
compose_snapshot up -d --no-deps "$API_SERVICE"
API_STOPPED=false

# O healthcheck, sozinho, não prova que a nova imagem está em execução. Exigir
# novo container e conferir o commit alvo nos labels do container e da imagem.
NEW_API_CONTAINER="$(compose_snapshot ps -q "$API_SERVICE" | head -n 1)"
[[ -n "$NEW_API_CONTAINER" ]] || die "Compose nao encontrou o container api atualizado."
[[ "$NEW_API_CONTAINER" != "$API_CONTAINER" ]] || die "O container api nao foi recriado; recusando validar somente o healthcheck."
SERVICE_REVISION="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$NEW_API_CONTAINER")"
RUNNING_IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "$NEW_API_CONTAINER")"
NEW_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$NEW_API_CONTAINER")"
IMAGE_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$NEW_IMAGE_ID")"
TARGET_TAG_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$TARGET_IMAGE_TAG")"
[[ "$SERVICE_REVISION" == "$TARGET_COMMIT" && "$IMAGE_REVISION" == "$TARGET_COMMIT" && "$RUNNING_IMAGE_REF" == "$TARGET_IMAGE_TAG" && "$NEW_IMAGE_ID" == "$TARGET_TAG_IMAGE_ID" ]] || die "A API ativa nao comprova o commit e a referencia de imagem alvo ($TARGET_COMMIT); rollback automatico sera iniciado."
echo "Commit da API e referencia persistente conferidos: $TARGET_COMMIT ($TARGET_IMAGE_TAG)"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/health}"
HEALTH_OK=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 5 "$HEALTH_URL" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="online" and d.get("banco")=="PostgreSQL conectado" else 1)' 2>/dev/null; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done
[[ "$HEALTH_OK" == true ]] || die "Healthcheck nao confirmou API e PostgreSQL apos 60 segundos."
compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT mp_environment, count(*) AS eventos FROM public.pix_webhook_inbox GROUP BY mp_environment ORDER BY mp_environment;"' || true
echo "Atualizacao concluida."
echo "API: $HEALTH_URL"
echo "Commit: $TARGET_COMMIT"
echo "Backup/rollback: $BACKUP_DIR"
echo "Producao permanece desativada; nenhuma cobranca ou chamada externa foi criada pelo script."
echo "Fim: $(date -Is)"
trap - EXIT
