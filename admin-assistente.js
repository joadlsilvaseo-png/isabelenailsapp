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
  return texto.normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase();
}
function determinarPeriodo(pergunta) {
  const hoje = dataSaoPaulo();
  const texto = normalizar(pergunta);
  if (/\\bamanha\\b/.test(texto)) {
    const data=adicionarDia(hoje,1);return {mes:data.slice(0,7),data};
  }
  if (/\\bhoje\\b/.test(texto)) return {mes:hoje.slice(0,7),data:hoje};
  const mesAtual=hoje.slice(0,7);
  const janela=[mesAtual,adicionarMes(mesAtual,1),adicionarMes(mesAtual,2)];
  const correspondente=janela.find((mes)=>texto.includes(normalizar(NOMES[Number(mes.slice(5))-1])));
  if (correspondente) return {mes:correspondente};
  if (/proxim[oa] mes|mes que vem/.test(texto)) return {mes:janela[1]};
  if (/esse mes|este mes|mes atual|\\bmes\\b|lacuna|encaixe|oportunidade|agenda/.test(texto)) {
    return {mes:mesAtual};
  }
  return null;
}
function dataFormatada(data) {
  return data.split("-").reverse().join("/");
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
function renderizarResultado(dados,periodo) {
  const bloco=elemento("article","assistente-bolha assistente-resultado");
  const titulo=elemento("h3","",dados.total===1?"1 oportunidade encontrada":`${dados.total} oportunidades encontradas`);
  bloco.append(titulo);
  const descricao=periodo.data ? dataFormatada(periodo.data) : `${NOMES[Number(periodo.mes.slice(5))-1]} de ${periodo.mes.slice(0,4)}`;
  bloco.append(elemento("p","assistente-meta",`Período: ${descricao}. Somente encaixes que exigem reduzir o buffer de 15 minutos.`));
  if(!dados.oportunidades?.length){
    bloco.append(elemento("p","","Não há encaixes excepcionais identificados neste período. Isso não significa que a agenda esteja cheia; horários normais continuam disponíveis na agenda."));
  }
  for(const item of (dados.oportunidades||[])){
    const card=elemento("section","assistente-oportunidade");
    card.append(elemento("h4","",`${dataFormatada(item.data)} · ${item.inicio} às ${item.fim}`));
    card.append(elemento("p","",`Lacuna de ${item.duracaoLacunaMinutos} minutos entre dois atendimentos.`));
    const lista=elemento("ul","assistente-servicos");
    for(const opcao of item.opcoes){
      const li=elemento("li");
      const nome=elemento("strong","",`${opcao.servico} · ${opcao.duracaoMinutos} min`);
      const inicios=opcao.horarios.length>8?`${opcao.horarios.slice(0,8).join(", ")} e mais ${opcao.horarios.length-8}` : opcao.horarios.join(", ");
      li.append(nome,document.createTextNode(` — início(s): ${inicios}`));
      lista.append(li);
    }
    card.append(lista);
    const link=elemento("a","","Conferir no Gerenciador de Calendário");
    link.href="./admin-calendario.html";
    card.append(link);
    bloco.append(card);
  }
  bloco.append(elemento("p","assistente-meta","Sugestões sujeitas a conferência. O assistente não confirma atendimentos nem recebe PIX."));
  conversa.append(bloco);
  conversa.scrollTop=conversa.scrollHeight;
}
async function consultar(pergunta){
  if(!autorizado||carregando)return;
  const periodo=determinarPeriodo(pergunta);
  adicionarBolha(pergunta,"cliente");
  if(!periodo){adicionarBolha("Posso consultar hoje, amanhã ou um mês da janela administrativa. Experimente: 'Quais encaixes temos em dezembro?'");return}
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
    const q={hoje:"Quais encaixes temos hoje?",amanha:"Quais encaixes temos amanhã?",mes:"Quais encaixes temos este mês?",proximo:"Quais encaixes temos no próximo mês?"}[chave];
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
