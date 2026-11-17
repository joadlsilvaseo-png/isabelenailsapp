const texto = (valor) => String(valor ?? "").trim();
const normalizarStatus = (valor) => texto(valor || "agendado").toLowerCase();

// Mensagens push usam a data local da agenda, sem depender do fuso do servidor.
function formatarData(data) {
  const valor = texto(data);
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : valor;
}

function formatarMomento(data, horario) {
  const dia = formatarData(data);
  const hora = texto(horario).slice(0, 5);
  if (dia && hora) return `${dia} às ${hora}`;
  return dia || (hora ? `às ${hora}` : "");
}

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
    const canceladoPelaCliente = atual.status === "cancelado_cliente";
    const nomeCliente = texto(atual.nomeCliente) || "Uma cliente";
    const servico = texto(atual.servico) || "atendimento";
    const quando = formatarMomento(atual.data, atual.horario);
    const mensagem = canceladoPelaCliente
      ? `${nomeCliente} cancelou o agendamento de ${servico}${quando ? `, marcado para ${quando}` : ""}.`
      : `Seu agendamento de ${servico}${quando ? `, marcado para ${quando},` : ""} foi cancelado pela Isabele.`;
    return [{
      tipo: canceladoPelaCliente ? "cancelamento_cliente" : "cancelamento_profissional",
      destinatario: canceladoPelaCliente ? "admin" : "cliente",
      titulo: "Agendamento cancelado",
      mensagem,
      destino: canceladoPelaCliente ? "./admin-agendamentos.html" : "./meu-perfil.html"
    }];
  }

  if (atual.status === "reagendado" && (statusMudou || dataMudou)) {
    const feitoPelaCliente = atual.reagendadoPor && atual.reagendadoPor === atual.clienteId;
    const nomeCliente = texto(atual.nomeCliente) || "Uma cliente";
    const servico = texto(atual.servico) || "atendimento";
    const anteriorQuando = formatarMomento(anterior.data_agendamento ?? anterior.data, anterior.horario);
    const novoQuando = formatarMomento(atual.data, atual.horario);
    const mudanca = [
      dataMudou && anteriorQuando ? `Anterior: ${anteriorQuando}.` : "",
      novoQuando ? `Novo: ${novoQuando}.` : ""
    ].filter(Boolean).join(" ");
    const introducao = feitoPelaCliente
      ? `${nomeCliente} reagendou ${servico}.`
      : `Seu atendimento de ${servico} foi reagendado pela Isabele.`;
    return [{
      tipo: "reagendamento",
      destinatario: feitoPelaCliente ? "admin" : "cliente",
      titulo: "Agendamento reagendado",
      mensagem: `${introducao}${mudanca ? ` ${mudanca}` : ""}`,
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
