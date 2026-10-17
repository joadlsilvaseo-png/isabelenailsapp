const ERROS = {
  preco: "Preco do servico invalido",
  ausente: "Sinal PIX nao configurado para este servico",
  tipo: "Tipo de sinal PIX invalido",
  fixo: "Valor fixo do sinal deve ser maior que zero e nao superar o preco",
  percentual: "Percentual do sinal deve ser maior que zero e no maximo 100",
};

export function converterPrecoServicoCentavos(valor) {
  let centavos;

  if (typeof valor === "number") {
    centavos = Math.round(valor * 100);
    if (Math.abs(valor * 100 - centavos) > 1e-7) throw new Error(ERROS.preco);
  } else {
    const texto = String(valor ?? "").trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
    let decimal;
    if (texto.includes(",")) decimal = texto.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(texto)) decimal = texto.replace(/\./g, "");
    else decimal = texto;
    if (!/^\d+(\.\d{1,2})?$/.test(decimal)) throw new Error(ERROS.preco);
    const [reais, centavosTexto = ""] = decimal.split(".");
    centavos = Number(reais) * 100 + Number(centavosTexto.padEnd(2, "0"));
  }

  if (!Number.isSafeInteger(centavos) || centavos <= 0) throw new Error(ERROS.preco);
  return centavos;
}

/** Calcula o valor PIX exclusivamente com a regra persistida no documento servicos/{id}. */
export function calcularSinalServico(servico) {
  const valorTotalCentavos = converterPrecoServicoCentavos(servico?.preco);
  const tipoSinal = servico?.pixSinalTipo;

  if (!tipoSinal) throw new Error(ERROS.ausente);
  if (!["fixo", "percentual"].includes(tipoSinal)) throw new Error(ERROS.tipo);

  let percentualSinal = null;
  let valorFixoConfiguradoCentavos = null;
  let valorSinalCentavos;

  if (tipoSinal === "fixo") {
    valorFixoConfiguradoCentavos = Number(servico.pixSinalValorCentavos);
    if (!Number.isSafeInteger(valorFixoConfiguradoCentavos) || valorFixoConfiguradoCentavos <= 0 || valorFixoConfiguradoCentavos > valorTotalCentavos) {
      throw new Error(ERROS.fixo);
    }
    valorSinalCentavos = valorFixoConfiguradoCentavos;
  } else {
    percentualSinal = Number(servico.pixSinalPercentual);
    const pontosPercentuais = Math.round(percentualSinal * 100);
    if (!Number.isFinite(percentualSinal) || percentualSinal <= 0 || percentualSinal > 100 || Math.abs(percentualSinal * 100 - pontosPercentuais) > 1e-7) {
      throw new Error(ERROS.percentual);
    }
    valorSinalCentavos = Math.round(valorTotalCentavos * pontosPercentuais / 10000);
  }

  if (!Number.isSafeInteger(valorSinalCentavos) || valorSinalCentavos <= 0 || valorSinalCentavos > valorTotalCentavos) {
    throw new Error(ERROS.fixo);
  }

  return {
    valorTotalCentavos,
    tipoSinal,
    percentualSinal,
    valorFixoConfiguradoCentavos,
    valorSinalCentavos,
    valorRestanteCentavos: valorTotalCentavos - valorSinalCentavos,
  };
}

export function criarCamposSinalServico(preco, tipo, entrada) {
  if (!tipo) {
    return { pixSinalTipo: null, pixSinalValorCentavos: null, pixSinalPercentual: null };
  }
  const campos = {
    pixSinalTipo: tipo,
    pixSinalValorCentavos: tipo === "fixo" ? converterPrecoServicoCentavos(entrada) : null,
    pixSinalPercentual: tipo === "percentual" ? Number(entrada) : null,
  };
  calcularSinalServico({ preco, ...campos });
  return campos;
}

export function obterEntradaSinalServico(servico) {
  if (servico?.pixSinalTipo === "fixo") {
    return { tipo: "fixo", valor: (Number(servico.pixSinalValorCentavos) / 100).toFixed(2) };
  }
  if (servico?.pixSinalTipo === "percentual") {
    return { tipo: "percentual", valor: String(servico.pixSinalPercentual ?? "") };
  }
  return { tipo: "", valor: "" };
}

export function formatarSinalServico(servico) {
  const valores = calcularSinalServico(servico);
  if (valores.tipoSinal === "fixo") {
    return `Fixo: ${formatarCentavos(valores.valorSinalCentavos)}`;
  }
  return `${formatarPercentual(valores.percentualSinal)}% (${formatarCentavos(valores.valorSinalCentavos)})`;
}

function formatarCentavos(centavos) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(centavos / 100);
}

function formatarPercentual(percentual) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(percentual);
}
