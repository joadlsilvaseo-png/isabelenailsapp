# Auditoria: alteração de serviço em agendamento confirmado

Base examinada: `origin/main` em `0cab3db5f84b77aaf3e9a90fb2173b38d34fd9b4`.

## Fluxos e garantias existentes

- Rotas administrativas autenticam o token Firebase com `verificarUsuario` e leem `usuarios/{uid}` no backend; o papel precisa ser `admin` e `ativo: true`.
- `POST /agendamentos/reagendar` em `agendamentosIsencaoPix.js` usa o advisory lock `isabele_pix_agenda` por data, consulta `agenda_bloqueios`, consulta `pix_reservas` ativas, valida a grade por `validarHorarioPix` e consulta os documentos Firestore do dia. A reserva usa intervalo semiaberto e a constraint `pix_reservas_sem_sobreposicao` bloqueia sobreposições.
- A criação PIX usa o mesmo advisory lock por data. O fechamento administrativo de horários também o usa. O fim persistido na reserva é calculado com a duração real em minutos.
- Reservas PIX relacionam `pix_reservas.cobranca_id` a `pix_cobrancas.id` e `agendamento_id` ao documento Firestore. O registro da cobrança guarda o valor e estado efetivamente conciliados. Alterar preço comercial não deve escrever em `pix_cobrancas` nem em `pix_eventos`.
- A tela de conclusão sugere `precoSnapshot` (ou `valorFinal` quando já existe). O detalhe administrativo exibe `precoSnapshot`, `valorSinalCentavos` e `valorRestanteCentavos`.
- `pix_calendar_outbox` é uma fila de criação (`AGENDAR`); `agendamento_cancelamentos` mantém a fila de cancelamento (`CANCELAR`). Ambas exigem confirmação estruturada do Apps Script e usam o `eventId` estável.
- `firestore.rules` só permite escrita em `agendamentos` por admin. A subcoleção de auditoria da nova operação deve ser legível apenas por admin e não deve ampliar leituras públicas.

## Risco e dependência do Google Calendar

O Apps Script chamado pelo backend é externo e seu código não está versionado neste repositório. Os contratos inspecionáveis implementam `AGENDAR` e `CANCELAR`; não foi possível verificar uma ação segura para localizar e atualizar o evento existente. Não se deve reutilizar `AGENDAR` como se fosse atualização.

A implementação deve enviar uma ação distinta de atualização, conservar o `eventId`, aceitar sucesso somente com confirmação explícita do script e persistir tentativas. Enquanto não houver confirmação, o estado deve permanecer pendente e ser mostrado como tal. Para implantação completa, o Apps Script precisa localizar o evento pelo ID estável, alterar título/início/fim no mesmo evento, devolver `{ ok: true, eventId, updated: true }` e tratar repetição idempotentemente. Essa alteração externa e sua validação integrada continuam pendentes.

## Implantação e recuperação

O procedimento atual é `infra/scripts/atualizar-vps-pix.sh`, documentado em `infra/scripts/README-atualizacao-vps-pix.md`. O script coleta backup, valida o Compose efetivo, constrói uma imagem versionada, faz preflight de migrações e mantém rollback de código; migrações já aplicadas não são revertidas automaticamente. Se esta implementação incluir a migração 020, o preflight e a aplicação da 020 precisam ser incluídos no mesmo script antes de qualquer implantação. Nenhum banco real, VPS, Firebase ou Calendar foi acessado nesta auditoria.

## Dados e pagamentos

O serviço e a duração devem vir de `servicos/{id}` no servidor. A reserva vinculada pode ter `cobranca_id`; qualquer ajuste de intervalo deve preservar esse vínculo e o estado conciliado. O sinal pago deve ser obtido da cobrança validada e o novo restante calculado como `max(0, preço_novo_centavos - sinal_pago_centavos)`. O histórico da cobrança permanece inalterado. Nenhum reembolso ou nova cobrança faz parte da operação.
