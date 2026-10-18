const texto = (valor) => String(valor ?? "").trim();
const normalizarStatus = (valor) => texto(valor || "agendado").toLowerCase();

export function identificarNotificacoesAgendamento(anterior, atual) {
  const detalhes = [
    atual.servico || "Atendimento",
    atual.data,
    atual.horario ? `às ${atual.horario}` : ""
  ].filter(Boolean).join(" ");

  if (!anterior) {
    if (atual.origemPagamento === "mercado_pago_pix" && atual.status === "confirmado") {
      return [
        {
          tipo: "confirmacao_pix_cliente",
          destinatario: "cliente",
          titulo: "Agendamento confirmado!",
          mensagem: `Seu pagamento PIX foi aprovado e seu atendimento está confirmado para ${atual.data}, às ${atual.horario}.`,
          destino: "./meu-perfil.html"
        },
        {
          tipo: "novo_agendamento_pix_admin",
          destinatario: "admin",
          titulo: "Novo agendamento confirmado!",
          mensagem: `${atual.nomeCliente || "Cliente"} confirmou o atendimento de ${atual.servico || "serviço"} para ${atual.data}, às ${atual.horario}. Sinal PIX recebido.`,
          destino: "./admin-agendamentos.html"
        }
      ];
    }
    if (atual.origemPagamento === "isencao_sinal_pix" && atual.status === "confirmado") {
      return [
        {
          tipo: "confirmacao_isencao_cliente",
          destinatario: "cliente",
          titulo: "Agendamento confirmado!",
          mensagem: `Seu atendimento está confirmado para ${atual.data}, às ${atual.horario}. Não foi necessário pagar sinal PIX.`,
          destino: "./meu-perfil.html"
        },
        {
          tipo: "novo_agendamento_isento_admin",
          destinatario: "admin",
          titulo: "Novo agendamento confirmado",
          mensagem: `${atual.nomeCliente || "Cliente"} agendou ${atual.servico || "atendimento"} para ${atual.data}, às ${atual.horario}, com isenção de sinal PIX.`,
          destino: "./admin-agendamentos.html"
        }
      ];
    }
    return [{
      tipo: "novo_agendamento",
      destinatario: "admin",
      titulo: "Novo agendamento",
      mensagem: `Uma nova reserva foi realizada: ${detalhes}.`,
      destino: "./admin-agendamentos.html"
    }];
  }

  const statusAnterior = normalizarStatus(anterior.status);
  const statusMudou = statusAnterior !== atual.status;
  const dataMudou = texto(anterior.data_agendamento ?? anterior.data) !== atual.data ||
    texto(anterior.horario) !== atual.horario;

  if (atual.status.startsWith("cancelado") && statusMudou) {
    const cliente = atual.status === "cancelado_cliente";
    return [{
      tipo: cliente ? "cancelamento_cliente" : "cancelamento_profissional",
      destinatario: cliente ? "admin" : "cliente",
      titulo: "Agendamento cancelado",
      mensagem: `O agendamento de ${atual.servico || "atendimento"} foi cancelado.`,
      destino: cliente ? "./admin-agendamentos.html" : "./meu-perfil.html"
    }];
  }

  if (atual.status === "reagendado" && (statusMudou || dataMudou)) {
    const feitoPelaCliente = atual.reagendadoPor && atual.reagendadoPor === atual.clienteId;
    return [{
      tipo: "reagendamento",
      destinatario: feitoPelaCliente ? "admin" : "cliente",
      titulo: "Agendamento reagendado",
      mensagem: `Nova data do atendimento: ${detalhes}.`,
      destino: feitoPelaCliente ? "./admin-agendamentos.html" : "./meu-perfil.html"
    }];
  }

  if (atual.status === "confirmado" && statusMudou) {
    return [{
      tipo: "confirmacao",
      destinatario: "cliente",
      titulo: "Agendamento confirmado",
      mensagem: `Seu atendimento foi confirmado: ${detalhes}.`,
      destino: "./meu-perfil.html"
    }];
  }
  return [];
}
