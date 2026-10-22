import { db } from "./firebase-config.js";
import { categoriaAtiva, servicoAtivo, servicoPertenceCategoria } from "./categoriasCatalogo.mjs";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const list = document.getElementById("lista-servicos");
const count = document.getElementById("category-service-count");
const title = document.getElementById("dynamic-category-title");
const heading = document.getElementById("dynamic-category-heading");
const description = document.getElementById("dynamic-category-description");
const continueButton = document.querySelector(".manicure-button");
let selectedId = "";

function html(tag, className, text) { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; }
function formatPrice(value) { const n = Number(String(value ?? "").replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? new Intl.NumberFormat("pt-BR", {style:"currency",currency:"BRL"}).format(n) : "Valor a consultar"; }
function renderState(message) { list.replaceChildren(); const li=html("li","manicure-state-card",message); list.append(li); }
function renderService(service) {
 const li=html("li","manicure-card",""); li.dataset.serviceId=service.id; li.dataset.serviceName=service.nome || "Serviço"; li.setAttribute("role","button"); li.setAttribute("tabindex","0"); li.setAttribute("aria-pressed","false");
 const top=html("div","manicure-card-top",""); const icon=html("span","manicure-card-icon",""); icon.setAttribute("aria-hidden","true"); icon.innerHTML='<svg viewBox="0 0 24 24" fill="none"><path d="M12 3L13.2 6.2L16.5 7.5L13.2 8.8L12 12L10.8 8.8L7.5 7.5L10.8 6.2L12 3Z" stroke="currentColor" stroke-width="1.8"/></svg>';
 const content=html("div","manicure-card-content",""); content.append(html("p","manicure-card-name",service.nome || "Serviço"),html("p","manicure-card-description",service.descricao || "Procedimento oferecido nesta categoria."));
 const check=html("span","manicure-card-check",""); check.setAttribute("aria-hidden","true"); top.append(icon,content,check);
 const details=html("div","manicure-card-details",""); const duration=html("span","manicure-card-duration",`${Number(service.duracao)||60} min`); details.append(duration,html("strong","manicure-card-price",formatPrice(service.preco))); li.append(top,details);
 const select=()=>{list.querySelectorAll(".manicure-card").forEach(card=>{card.classList.toggle("selected",card===li);card.setAttribute("aria-pressed",String(card===li));});selectedId=service.id;continueButton.disabled=false;document.getElementById("selected-service-summary").textContent=`${service.nome} selecionado`;};
 li.addEventListener("click",select); li.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select();}}); return li;
}
async function init(){
 const id=new URLSearchParams(location.search).get("categoriaId");
 if(!id){renderState("Categoria não encontrada.");return;}
 try {
  const [cats,services]=await Promise.all([getDocs(collection(db,"categorias")),getDocs(collection(db,"servicos"))]);
  const categoryDoc=cats.docs.find(doc=>doc.id===id); const category=categoryDoc?{id:categoryDoc.id,...categoryDoc.data()}:null;
  if(!categoriaAtiva(category)){renderState("Esta categoria não está disponível.");return;}
  title.textContent=category.nome||"Serviços"; heading.textContent=category.nome||"Serviços"; description.textContent=category.descricao||"Escolha um procedimento desta categoria."; document.title=`${category.nome||"Serviços"} | Isabele Mariana Nails`;
  const rows=services.docs.map(doc=>({id:doc.id,...doc.data()})).filter(service=>servicoAtivo(service)&&servicoPertenceCategoria(service,category));
  list.replaceChildren(); list.classList.remove("loading"); list.setAttribute("aria-busy","false");
  if(count) count.textContent=`${rows.length} ${rows.length===1?"serviço":"serviços"}`;
  if(!rows.length){renderState("Nenhum procedimento disponível no momento.");return;}
  rows.forEach(service=>list.append(renderService(service)));
 } catch(error){console.error("Falha ao carregar categoria:",error);renderState("Não foi possível carregar os serviços. Tente novamente.");}
}
continueButton?.addEventListener("click",()=>{if(selectedId)location.href=`agendamento.html?id=${encodeURIComponent(selectedId)}`;});
void init();
