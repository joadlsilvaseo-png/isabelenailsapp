#!/usr/bin/env python3
"""Corte controlado do Google Calendar GAS -> Events API. Nao mexe no banco.

Requer PWA v32 publicado, tres excecoes conciliadas e cinco novos vinculados (119+),
ZERO filas pendentes e imagem nova validada pelo SHA do build.
Nao reinicia postgres, nao roda migrations nem modifica Google.
Desfaz Compose se falhar ANTES de qualquer operacao direta nova.
Nao devolve para GAS se houver operacao direta real no PostgreSQL.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import urlopen

API="isabele-infra-api-1"
NEW_SHA=sys.argv[2] if len(sys.argv)==3 else ""
IMAGE="isabele-nails-api:calendar-stage-"+NEW_SHA[:12]
PROJECT="isabele-infra"
ROOT="/opt/isabele-nails-backups/pix-update-20261107T205713Z-2709330"
FILES=[
    ROOT+"/effective-before.yaml",
    ROOT+"/update-compose.yaml",
    "/opt/isabele-oauth-stage-KKTWRW/compose.oauth.yaml",
    "/root/.config/isabele-google-oauth/compose.enable.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-ac45382d3717.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-3b5e9b72c4eb.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-dfd5e0f2bf53.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-"+NEW_SHA[:12]+".yaml",
]
OVERLAY=Path("/root/.config/isabele-google-oauth/calendar-cutover-direct-20261109.yaml")
BASE=["docker","compose","-p",PROJECT,"--project-directory",ROOT]
for f in FILES:BASE+=["-f",f]
TARGET=BASE+["-f",str(OVERLAY)]
DB_CMD=["docker","exec","-i","isabele-infra-postgres-1","sh","-c",
    'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
FLAGS=[
    "GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_REAGENDAR_PAGO_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_REAGENDAR_ISENTO_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_ALTERAR_SERVICO_ENABLED",
    "GOOGLE_CALENDAR_FRONTEND_PWA_READY",
]

class Block(Exception):pass
def call(args,stdin=None,strict=True):
    p=subprocess.run(args,text=True,input=stdin,capture_output=True)
    if strict and p.returncode:raise Block("COMANDO_FALHOU_"+str(p.returncode))
    return p
def readjson(args):
    try:return json.loads(call(args).stdout)
    except Exception as exc:raise Block("JSON_DOCKER_INVALIDO") from exc
def inspect():
    v=readjson(["docker","inspect",API])
    if not isinstance(v,list) or len(v)!=1:raise Block("API_NAO_ENCONTRADA")
    return v[0]
def envmap(container):
    return dict(x.split("=",1) for x in container["Config"]["Env"] if "=" in x)
def conf(args):
    return readjson(args+["config","--format","json"])
def sql(q):
    result=call(DB_CMD,stdin=q)
    return result.stdout.strip()
def count(q):
    v=sql(q)
    if not v.isdecimal():raise Block("CONSULTA_NAO_NUMERICA")
    return int(v)
def check_db(expect_link_count=True):
    if expect_link_count:
        total=count("SELECT COUNT(*) FROM public.google_calendar_event_links;")
        if total<119:
            raise Block("VINCULOS_MINIMOS_119_NAO_CONFIRMADOS")
        if count("SELECT COUNT(*) FROM public.google_calendar_event_links "
          "WHERE verificado_por='conciliacao-excecoes-20261109';")!=3:
            raise Block("TRES_EXCECOES_NAO_PRESERVADAS")
        if count("SELECT COUNT(*) FROM public.google_calendar_event_links "
          "WHERE verificado_por='conciliacao-cinco-recentes-20261109';")!=5:
            raise Block("CINCO_RECENTES_NAO_CONFIRMADOS")
    for name,q in [
      ("CRIACOES_PENDENTES","SELECT COUNT(*) FROM public.pix_calendar_outbox WHERE status IN ('pendente','enviando');"),
      ("CANCELAMENTOS_PENDENTES","SELECT COUNT(*) FROM public.agendamento_cancelamentos WHERE calendar_estado IN ('pendente','enviando');"),
      ("REAGENDAMENTOS_PENDENTES","SELECT COUNT(*) FROM public.pix_reagendamentos_pagos WHERE estado <> 'concluida';"),
      ("ALTERACOES_PENDENTES","SELECT COUNT(*) FROM public.agendamento_alteracoes_servico WHERE estado IN ('solicitada','processando');"),
      ("GOOGLE_PENDENTES","SELECT COUNT(*) FROM public.google_calendar_sync_operations WHERE estado <> 'concluida';"),
      ("SEM_VINCULO","SELECT COUNT(*) FROM public.pix_calendar_outbox o WHERE o.status='enviado' AND o.data_servico>=CURRENT_DATE AND NOT EXISTS (SELECT 1 FROM public.google_calendar_event_links l WHERE l.agendamento_id=o.agendamento_id) AND NOT EXISTS (SELECT 1 FROM public.agendamento_cancelamentos c WHERE c.agendamento_id=o.agendamento_id AND c.estado IN ('concluida','solicitada'));"),
    ]:
        if count(q)!=0:raise Block(name)
def health():
    try:
        with urlopen("http://127.0.0.1:3001/health",timeout=4) as r:
            return r.status==200 and json.load(r).get("status")=="online"
    except Exception:return False
def confirm_site():
    for url,frag in [
      ("https://isabelenailsapp.vercel.app/agendamento.html",b'agendamento.js?v=2.4.1'),
      ("https://isabelenailsapp.vercel.app/service-worker.js",b'const CACHE_VERSION = "v32"'),
      ("https://isabelenailsapp.vercel.app/agendamento.js?v=2.4.1",b'calendarClientSupportsBackend: true'),
    ]:
        try:
            with urlopen(url,timeout=18) as r:
                if r.status!=200 or frag not in r.read(300000):
                    raise Block("PWA_NAO_PUBLICADO")
        except Block:raise
        except Exception as exc:raise Block("PWA_NAO_VERIFICADO") from exc
def recreate(config):
    return call(config+["up","-d","--no-deps","--no-build",
        "--force-recreate","api"],strict=False).returncode==0
def wait(tag,expected,timeout=22):
    for _ in range(timeout):
        try:
            c=inspect()
            if c["Config"]["Image"]==tag and c["State"]["Running"] and health():
                e=envmap(c)
                if all(e.get(k)==v for k,v in expected.items()):
                    return True
        except Exception:pass
        time.sleep(2)
    return False
def flags_all_disabled(old):
    if any(old.get(k)=="true" for k in FLAGS):
        raise Block("FLAGS_DIRETAS_JA_LIGADAS")
    if old.get("GOOGLE_CALENDAR_OAUTH_ENABLED")!="true":
        raise Block("OAUTH_NAO_ATIVO")
    if old.get("PIX_CALENDAR_WORKER_ENABLED")!="true":
        raise Block("PIX_CALENDAR_WORKER_NAO_ATIVO")
def create_overlay(cutoff):
    flags={key:"true" for key in FLAGS}
    flags["GOOGLE_CALENDAR_CUTOVER_STARTED_AT"]=cutoff
    content="services:\n  api:\n    environment:\n"
    content+="".join("      "+key+': "'+value+'"\n' for key,value in flags.items())
    if OVERLAY.exists():
        if OVERLAY.read_text()!=content:
            raise Block("OVERRIDE_CUTOVER_JA_EXISTE_DIFERENTE")
    else:
        OVERLAY.parent.mkdir(parents=True,exist_ok=True)
        with OVERLAY.open("x") as h:h.write(content)
        OVERLAY.chmod(0o600)
    return flags
def capture_backup(cutoff):
    stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory=Path("/opt/isabele-nails-backups/calendar-cutover-"+stamp)
    directory.mkdir(mode=0o700,parents=True,exist_ok=False)
    b=directory/"postgres.dump"
    dumpcmd=["docker","exec","-i","isabele-infra-postgres-1","sh","-c",
      'pg_dump -Fc --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
    with b.open("wb") as output:
        p=subprocess.run(dumpcmd,stdout=output,stderr=subprocess.DEVNULL)
    if p.returncode!=0 or b.stat().st_size<1024:
        raise Block("BACKUP_POSTGRES_FALHOU")
    b.chmod(0o600)
    meta={
        "cutoff":cutoff,
        "image":IMAGE,
        "composePre":FILES,
        "composeOn":FILES+[str(OVERLAY)],
        "backup":str(b),
        "override_sha256":hashlib.sha256(OVERLAY.read_bytes()).hexdigest(),
        "rollback":"Remover nono Compose SOMENTE se nenhuma operacao nova registrada; verificar antes."
    }
    r=directory/"registro.json"
    with r.open("x") as h:json.dump(meta,h,indent=2)
    r.chmod(0o600)
    print("BACKUP_CUTOVER_OK")
    print("REGISTRO="+str(r))
def safe_rollback_possible():
    return count("SELECT COUNT(*) FROM public.google_calendar_sync_operations;")==0 and \
      count("SELECT COUNT(*) FROM public.google_calendar_creation_authorizations;")==0
def main():
    if len(sys.argv)!=3 or sys.argv[1] not in ("--preflight","--activate") or not re.fullmatch(r"[a-f0-9]{40}",NEW_SHA):
        raise Block("USO_--preflight_OU_--activate_SHA40")
    if os.geteuid()!=0:raise Block("ROOT_OBRIGATORIO")
    for path in FILES:
        if not Path(path).is_file():raise Block("COMPOSE_AUSENTE")
    c=inspect()
    if c["Config"]["Image"]!=IMAGE or not c["State"]["Running"]:
        raise Block("IMAGEM_DA_API_INESPERADA")
    img=readjson(["docker","image","inspect",IMAGE])
    if not isinstance(img,list) or len(img)!=1 or img[0].get("Id")!=c.get("Image") or \
       img[0].get("Config",{}).get("Labels",{}).get("org.opencontainers.image.revision")!=NEW_SHA:
        raise Block("IMAGEM_DIGEST_OU_REVISAO_INVALIDOS")
    labels=c["Config"].get("Labels") or {}
    if labels.get("com.docker.compose.project")!=PROJECT or \
       labels.get("com.docker.compose.project.working_dir")!=ROOT or \
       labels.get("com.docker.compose.project.config_files","").split(",")!=FILES:
        raise Block("COMPOSE_PRODUCAO_DIVERGENTE")
    current=envmap(c)
    flags_all_disabled(current)
    cfg=conf(BASE)
    if cfg.get("name")!=PROJECT or set(cfg.get("services",{}))!={"api","postgres"}:
        raise Block("COMPOSE_INESPERADO")
    api=cfg["services"]["api"]
    if api.get("image")!=IMAGE:raise Block("IMAGEM_COMPOSE_INESPERADA")
    for k,v in api.get("environment",{}).items():
        if current.get(k)!=("" if v is None else str(v)):
            raise Block("AMBIENTE_BASE_DIVERGENTE")
    if not health():raise Block("API_NAO_SAUDAVEL")
    confirm_site()
    check_db()
    print("PREFLIGHT_CUTOVER_OK")
    if sys.argv[1]=="--preflight":
        print("PRODUCAO_INALTERADA")
        return

    cutoff=datetime.now(timezone.utc).isoformat(timespec="seconds")
    expected=create_overlay(cutoff)
    target=conf(TARGET)
    verify=copy.deepcopy(cfg)
    verify["services"]["api"]["environment"].update(expected)
    if verify!=target:raise Block("CONFIG_ALTEROU_ALEM_DAS_FLAGS")
    check_db()
    capture_backup(cutoff)
    print("ATIVANDO_APENAS_API")
    ok=recreate(TARGET) and wait(IMAGE,expected)
    if not ok:
        # Nunca reenviar para GAS automaticamente se houve escrita direta,
        # pois um evento Google pode ter sido criado sem confirmacao local.
        if safe_rollback_possible():
            print("ERRO_DEPLOY_TENTANDO_ROLLBACK")
            if recreate(BASE) and wait(IMAGE,{k:current[k] for k in FLAGS if k in current}):
                raise Block("DEPLOY_FALHOU_ROLLBACK_OK")
            raise Block("DEPLOY_FALHOU_ROLLBACK_NAO_CONFIRMADO")
        raise Block("DEPLOY_FALHOU_COM_ESCRITA_DIRETA_RECONCILIAR_ANTES_DE_ROLLBACK")
    now=envmap(inspect())
    if now.get("GOOGLE_CALENDAR_CUTOVER_STARTED_AT")!=cutoff:
        raise Block("CUTOFF_DIVERGENTE_APOS_DEPLOY")
    print("CUTOVER_DIRETO_HABILITADO")
    print("TODOS_OS_CINCO_FLUXOS_API")
    print("WORKER_ANTIGO_SUBSTITUIDO_POR_TRANSPORTE_API")
    print("SAUDE_HTTP_200")
    print("POSTGRES_INTACTO")
    print("CORTE_UTC="+cutoff)

if __name__=="__main__":
    try:main()
    except Block as e:
        print("BLOQUEADO:",str(e),file=sys.stderr)
        sys.exit(1)
