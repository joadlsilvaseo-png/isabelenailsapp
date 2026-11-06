import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const acesso = document.getElementById("assistente-acesso");
const conteudo = document.getElementById("assistente-conteudo");
const conversa = document.getElementById("assistente-dialogo");
const form = document.getElementById("assistente-form");
const input = document.getElementById("assistente-pergunta");
const enviar = document.getElementById("assistente-enviar");
const NOMES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
let autorizado = false;
let carregando = false;

function dataSaoPaulo(data = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(data);
  const valores = Object.fromEntries(p.map(item=>[item.type,item.value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}
function adicionarDia(iso, qtd) {
  return new Date(Date.parse(iso+"T12:00:00Z")+qtd*86400000).toISOString().slice(0,10);
}
function adicionarMes(mes, qtd) {
  const [ano,m]=mes.split("-").map(Number);
  return new Date(Date.UTC(ano,m-1+qtd,1)).toISOString().slice(0,7);
}
function normalizar(texto) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
}
function determinarPeriodo(pergunta) {
  const hoje = dataSaoPaulo();
  const texto = normalizar(pergunta);
  if (/\bamanha\b/.test(texto)) {
    const data=adicionarDia(hoje,1);return {mes:data.slice(0,7),data};
  }
  if (/\bhoje\b/.test(texto)) return {mes:hoje.slice(0,7),data:hoje};
  const mesAtual=hoje.slice(0,7);
  const janela=[mesAtual,adicionarMes(mesAtual,1),adicionarMes(mesAtual,2)];
  const correspondente=janela.find((mes)=>texto.includes(normalizar(NOMES[Number(mes.slice(5))-1])));
  const numerica=texto.match(/(?:\bdia\s*)?(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{4}))?/);
  if(numerica){
    const ano=numerica[3]||hoje.slice(0,4);
    const data=`${ano}-${numerica[2].padStart(2,"0")}-${numerica[1].padStart(2,"0")}`;
    if(janela.includes(data.slice(0,7)))return {mes:data.slice(0,7),data};
  }
  const diaPorExtenso=texto.match(/\bdia\s+(\d{1,2})\s+de\s+([a-z]+)/);
  if(diaPorExtenso && correspondente){
    const data=`${correspondente}-${diaPorExtenso[1].padStart(2,"0")}`;
    return {mes:correspondente,data};
  }
  if (correspondente) return {mes:correspondente};
  if (/proxim[oa] mes|mes que vem/.test(texto)) return {mes:janela[1]};
  if (/esse mes|este mes|mes atual|\bmes\b|lacuna|intervalo|bloqueio|sugestao|avaliar|espaco|encaixe|oportunidade|agenda/.test(texto)) {
    return {mes:mesAtual};
  }
  return null;
}
function dataFormatada(data) {
  return data.split("-").reverse().join("/");
}
function formatarDuracao(minutos) {
  const horas = Math.floor(minutos / 60);
  const restantes = minutos % 60;
  if (horas === 0) return `${restantes} minuto${restantes === 1 ? "" : "s"}`;
  if (restantes === 0) return `${horas} hora${horas === 1 ? "" : "s"}`;
  return `${horas}h${String(restantes).padStart(2, "0")}`;
}
function elemento(tag,classe,texto) {
  const el=document.createElement(tag);
  if(classe)el.className=classe;
  if(texto!==undefined)el.textContent=texto;
  return el;
}
function adicionarBolha(texto,tipo="bot"){
  const el=elemento("article",`assistente-bolha assistente-bolha--${tipo}`,texto);
  conversa.append(el);
  conversa.scrollTop=conversa.scrollHeight;
  return el;
}
function icone(nome) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (nome === "relogio") {
    const circulo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circulo.setAttribute("cx", "12");
    circulo.setAttribute("cy", "12");
    circulo.setAttribute("r", "9");
    svg.append(circulo);
  }
  const caminho = document.createElementNS("http://www.w3.org/2000/svg", "path");
  caminho.setAttribute("d", nome === "relogio" ? "M12 7v5l3 2" : "m9 18 6-6-6-6");
  svg.append(caminho);
  return svg;
}
function renderizarResultado(dados, periodo) {
  const itens = Array.isArray(dados.oportunidades) ? dados.oportunidades : [];
  const total = itens.length;
  const bloco = elemento("article", "assistente-bolha assistente-resultado");
  bloco.append(elemento("h3", "", total === 1 ? "1 intervalo para avaliar" : total + " intervalos para avaliar"));
  const descricao = periodo.data ? dataFormatada(periodo.data)
    : NOMES[Number(periodo.mes.slice(5)) - 1] + " de " + periodo.mes.slice(0, 4);
  bloco.append(elemento("p", "assistente-meta", "Período consultado: " + descricao + ". Sugestões para análise da profissional."));
  if (!total) {
    bloco.append(elemento("p", "assistente-vazio",
      "Nenhum intervalo que exija atenção foi encontrado. Isso não significa que a agenda esteja cheia; horários regulares podem continuar disponíveis."));
  }
  for (const item of itens) {
    const card = elemento("section", "assistente-oportunidade");
    const selo = elemento("span", "assistente-selo");
    selo.append(icone("relogio"), document.createTextNode("Sugestão de bloqueio"));
    card.append(selo);
    card.append(elemento("h4", "", dataFormatada(item.data) + " · " + item.inicio + " às " + item.fim));
    card.append(elemento("p", "assistente-lacuna",
      "Intervalo disponível: " + formatarDuracao(item.duracaoLacunaMinutos)));
    card.append(elemento("p", "assistente-orientacao",
      item.justificativa || "Confira a disponibilidade antes de decidir se vale fechar este intervalo."));
    const elegiveis = Array.isArray(item.servicosElegiveis) ? item.servicosElegiveis : [];
    if (elegiveis.length) {
      const nomes = elegiveis.slice(0, 3).map((servico) => servico.nome).filter(Boolean);
      const adicionais = elegiveis.length > 3 ? " e mais " + (elegiveis.length - 3) : "";
      card.append(elemento("p", "assistente-elegiveis",
        "Serviços que ainda cabem: " + nomes.join(", ") + adicionais + "."));
    }
    const link = elemento("a", "assistente-link", "Conferir dia no calendário");
    link.href = "./admin-calendario.html?data=" + encodeURIComponent(item.data);
    link.append(icone("seta"));
    card.append(link);
    bloco.append(card);
  }
  bloco.append(elemento("p", "assistente-meta",
    "Nenhum bloqueio é feito automaticamente. A agenda e as reservas não foram alteradas."));
  conversa.append(bloco);
  conversa.scrollTop = conversa.scrollHeight;
}
async function consultar(pergunta){
  if(!autorizado||carregando)return;
  const periodo=determinarPeriodo(pergunta);
  adicionarBolha(pergunta,"cliente");
  if(!periodo){adicionarBolha("Posso consultar hoje, amanhã ou um mês da janela administrativa. Experimente: 'Quais intervalos merecem atenção em dezembro?'");return}
  carregando=true;
  enviar.disabled=true;
  const esperando=adicionarBolha("Analisando agendamentos, reservas e bloqueios...");
  try{
    const usuario=auth.currentUser;
    if(!usuario)throw new Error("Sessão encerrada.");
    const url=new URL("/api/admin/assistente/encaixes",window.location.origin);
    url.searchParams.set("mes",periodo.mes);
    if(periodo.data)url.searchParams.set("data",periodo.data);
    const resposta=await fetch(url,{cache:"no-store",headers:{Authorization:`Bearer ${await usuario.getIdToken()}`}});
    const resultado=await resposta.json();
    if(!resposta.ok)throw new Error(resultado.erro||`Falha HTTP ${resposta.status}`);
    esperando.remove();
    renderizarResultado(resultado,periodo);
  }catch(erro){
    esperando.textContent=erro.message||"Não foi possível consultar a agenda.";
  }finally{
    carregando=false;
    enviar.disabled=false;
    input.focus();
  }
}
form.addEventListener("submit",(event)=>{
  event.preventDefault();
  const pergunta=input.value.trim();
  if(!pergunta)return;
  input.value="";
  void consultar(pergunta);
});
document.querySelectorAll("[data-consulta]").forEach((botao)=>{
  botao.addEventListener("click",()=>{
    const chave=botao.dataset.consulta;
    const q={hoje:"Quais intervalos devo avaliar hoje?",amanha:"Quais intervalos devo avaliar amanhã?",mes:"Quais intervalos devo avaliar este mês?",proximo:"Quais intervalos devo avaliar no próximo mês?"}[chave];
    if(q)void consultar(q);
  });
});
onAuthStateChanged(auth,async(user)=>{
  autorizado=false;
  conteudo.hidden=true;
  acesso.hidden=false;
  if(!user){acesso.textContent="Entre na sua conta para acessar o Assistente de Agenda.";return}
  try{
    const perfil=await getDoc(doc(db,"usuarios",user.uid));
    if(!perfil.exists()||perfil.data().role!=="admin"||perfil.data().ativo!==true){
      acesso.textContent="Esta página é exclusiva da administração.";return;
    }
    autorizado=true;
    document.body.dataset.accessState="allowed";
    acesso.hidden=true;
    conteudo.hidden=false;
    input.focus();
  }catch{
    acesso.textContent="Não foi possível confirmar seu acesso. Atualize a página.";
  }
});
