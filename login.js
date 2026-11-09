import { trackEvent } from "./analytics.js";
import { auth, googleProvider, db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
let redirecionamentoEmAndamento = false;
// ============================================================
// JAVASCRIPT - Página Login (login.html)
// ============================================================

document.addEventListener("DOMContentLoaded", async function () {
  await initializeLogin();
});

/**
 * Função de inicialização da página de login
 */
async function initializeLogin() {
  console.log("Login page carregada");

  try {
    /*
     * Mantém a autenticação salva mesmo após
     * fechar e abrir novamente o navegador ou PWA.
     */
    await setPersistence(auth, browserLocalPersistence);

    console.log("[Login] Persistência local configurada.");
  } catch (error) {
    console.error("[Login] Erro ao configurar persistência:", error);
  }

  /*
   * Verifica se o Firebase restaurou uma sessão existente.
   * Nesse caso, o formulário não precisa ser preenchido novamente.
   */
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      console.log("[Login] Nenhuma sessão existente.");

      return;
    }

    console.log("[Login] Sessão existente encontrada:", user.uid);

    await redirectByRole(user);
  });

  setupFormValidation();
  setupGoogleLogin();
  setupPasswordToggle();
}

/**
 * Setup validação do formulário
 */
function setupFormValidation() {
  const loginForm = document.getElementById("loginForm");

  if (!loginForm) return;

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();

    const email = document.getElementById("emailInput").value.trim();
    const password = document.getElementById("passwordInput").value;

    // Validação básica
    if (!email || !password) {
      showError("Por favor, preencha todos os campos");
      return;
    }

    if (!App.isValidEmail(email)) {
      showError("Por favor, insira um email válido");
      return;
    }

    if (password.length < 6) {
      showError("A senha deve ter pelo menos 6 caracteres");
      return;
    }

    // Se passou nas validações
    performLogin(email, password);
  });
}

/**
 * Setup Google Login
 */
function celularBrasileiroValido(valor) {
  let digitos = String(valor || "").replace(/\D/g, "");
  if (digitos.length === 13 && digitos.startsWith("55")) {
    digitos = digitos.slice(2);
  }
  // DDD com 2 dígitos + celular brasileiro de 9 dígitos (começa com 9).
  return /^[1-9]\d9\d{8}$/.test(digitos);
}

function solicitarCelularGoogle() {
  return new Promise((resolve) => {
    const modal = document.createElement("dialog");
    modal.setAttribute("aria-labelledby", "google-phone-title");
    modal.style.cssText =
      "width:min(92vw,430px);max-width:430px;border:1px solid #e8c5d3;" +
      "border-radius:18px;padding:24px;background:#fffafb;color:#591c31;" +
      "font-family:Poppins,sans-serif;box-shadow:0 18px 60px #31102040";

    // Conteúdo estático: nenhum dado de usuário é interpolado no HTML.
    modal.innerHTML = `
      <h2 id="google-phone-title" style="font-size:20px;margin:0 0 10px">Só falta seu celular!</h2>
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px">
        Para concluir seu acesso, informe um número de celular para contato sobre seus agendamentos.
      </p>
      <form id="google-phone-form">
        <label for="google-phone-input" style="display:block;font-weight:600;margin-bottom:7px">Celular com DDD</label>
        <input id="google-phone-input" type="tel" inputmode="numeric" autocomplete="tel"
          placeholder="(11) 99999-9999" required maxlength="18"
          style="box-sizing:border-box;width:100%;padding:13px;border:1px solid #cfa7b7;border-radius:10px;font-size:16px">
        <p id="google-phone-error" role="alert" aria-live="polite"
          style="min-height:18px;color:#ae2443;font-size:12px;margin:7px 0 12px"></p>
        <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
          <button id="google-phone-cancel" type="button"
            style="padding:12px 16px;border:1px solid #cfa7b7;border-radius:10px;background:#fff;cursor:pointer">Cancelar</button>
          <button type="submit"
            style="padding:12px 16px;border:0;border-radius:10px;background:#591c31;color:white;font-weight:600;cursor:pointer">Salvar e continuar</button>
        </div>
      </form>`;

    modal.style.margin = "auto";
    document.body.append(modal);
    const formulario = modal.querySelector("#google-phone-form");
    const campo = modal.querySelector("#google-phone-input");
    const erro = modal.querySelector("#google-phone-error");
    let concluido = false;
    const terminar = (telefone = null) => {
      if (concluido) return;
      concluido = true;
      modal.close();
      modal.remove();
      resolve(telefone);
    };

    formulario.addEventListener("submit", (evento) => {
      evento.preventDefault();
      if (!celularBrasileiroValido(campo.value)) {
        erro.textContent = "Informe um celular válido com DDD (11 dígitos).";
        campo.focus();
        return;
      }
      let telefone = campo.value.replace(/\D/g, "");
      if (telefone.length === 13 && telefone.startsWith("55"))
        telefone = telefone.slice(2);
      terminar(telefone);
    });
    modal
      .querySelector("#google-phone-cancel")
      .addEventListener("click", () => terminar());
    modal.addEventListener("cancel", (evento) => {
      evento.preventDefault();
      terminar();
    });
    modal.showModal();
    campo.focus();
  });
}

/** Login Google: a criação/regularização do cadastro é feita em redirectByRole.
 * Assim o onAuthStateChanged não consegue redirecionar antes da validação.
 */
function setupGoogleLogin() {
  const googleBtn = document.getElementById("googleLoginBtn");
  if (!googleBtn) return;

  googleBtn.addEventListener("click", async function () {
    if (redirecionamentoEmAndamento) return;
    googleBtn.disabled = true;
    try {
      const result = await signInWithPopup(auth, googleProvider);
      trackEvent("login");
      await redirectByRole(result.user);
    } catch (error) {
      console.error("[Google Login] Erro", error);
      showError(error.message || "Erro ao fazer login com Google");
    } finally {
      googleBtn.disabled = false;
    }
  });
}

/**
 * Setup toggle de visibilidade da senha (opcional)
 */
function setupPasswordToggle() {
  const passwordInput = document.getElementById("passwordInput");
  if (!passwordInput) return;

  // "Estado" inicializado como falso
  let showPassword = false;

  // Criando o container do toggle dinamicamente para manter a estrutura do form
  const toggleContainer = document.createElement("div");
  toggleContainer.className = "show-password-container";

  toggleContainer.innerHTML = `
    <input type="checkbox" id="showPasswordToggle">
    <label for="showPasswordToggle">Mostrar senha</label>
  `;

  // Insere o toggle logo após o input de senha
  passwordInput.after(toggleContainer);

  const checkbox = document.getElementById("showPasswordToggle");

  // Listener para alternar o estado e o tipo do input
  checkbox.addEventListener("change", () => {
    showPassword = checkbox.checked;
    passwordInput.type = showPassword ? "text" : "password";
  });

  passwordInput.addEventListener("focus", function () {
    this.parentElement.classList.add("focused");
  });

  passwordInput.addEventListener("blur", function () {
    this.parentElement.classList.remove("focused");
  });
}

/**
 * Validação de email
 */
/**
 * Mostrar erro
 */
function showError(message) {
  console.warn("[Form Error]", message);
  // Aqui você pode adicionar um toast ou alerta visual
  alert(message);
}

/**
 * Realizar login
 */
async function performLogin(email, password) {
  console.log("[Login] Tentando fazer login com:", email);

  const loginBtn = document.querySelector(".login-button--primary");
  const originalText = loginBtn.textContent;
  loginBtn.textContent = "Autenticando...";
  loginBtn.disabled = true;

  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      email,
      password,
    );

    console.log("[Login] Sucesso");
    trackEvent("login");
    await redirectByRole(userCredential.user);
  } catch (error) {
    console.error("[Login] Erro", error);

    const errorCode = error.code || "";
    if (errorCode === "auth/user-not-found") {
      showError("Usuário não encontrado.");
    } else if (errorCode === "auth/wrong-password") {
      showError("Senha incorreta.");
    } else if (errorCode === "auth/invalid-credential") {
      showError("E-mail ou senha inválidos.");
    } else if (errorCode === "auth/invalid-email") {
      showError("E-mail inválido.");
    } else if (errorCode === "auth/network-request-failed") {
      showError("Verifique sua conexão.");
    } else {
      showError("Não foi possível realizar o login.");
    }
  } finally {
    loginBtn.textContent = originalText;
    loginBtn.disabled = false;
  }
}

async function redirectByRole(user) {
  if (!user || redirecionamentoEmAndamento) return;
  redirecionamentoEmAndamento = true;

  const entrouComGoogle = user.providerData?.some(
    (provider) => provider.providerId === "google.com",
  );

  try {
    const userRef = doc(db, "clientes", user.uid);
    const perfil = await getDoc(userRef);
    const roleLegado = perfil.exists() ? perfil.data().role : "cliente";

    // Administradoras não devem ser tratadas como novas clientes.
    // A coleção usuarios é a fonte atual das permissões de administração.
    let ehAdmin = roleLegado === "admin";
    if (entrouComGoogle && !ehAdmin) {
      const usuario = await getDoc(doc(db, "usuarios", user.uid));
      ehAdmin = usuario.exists() && usuario.data().role === "admin";
    }

    if (entrouComGoogle && !ehAdmin) {
      const telefoneAtual = perfil.exists()
        ? perfil.data().telefone ||
          perfil.data().celular ||
          perfil.data().whatsapp ||
          perfil.data().phone ||
          ""
        : "";

      if (!celularBrasileiroValido(telefoneAtual)) {
        const telefone = await solicitarCelularGoogle();
        if (!telefone) {
          // Cancelar não cria cadastro vazio e não libera o redirecionamento.
          await signOut(auth);
          return;
        }

        if (perfil.exists()) {
          // merge preserva nome, email, histórico e demais campos existentes.
          await setDoc(userRef, { telefone }, { merge: true });
        } else {
          await setDoc(userRef, {
            nome: user.displayName || "Cliente",
            email: user.email || "",
            telefone,
            role: "cliente",
            dataCadastro: new Date().toISOString(),
          });
        }
      }
    }

    if (roleLegado === "admin") {
      window.location.replace("dashboard.html");
      return;
    }
    window.location.replace("principal.html");
  } catch (error) {
    console.error("[Login] Erro ao verificar ou completar perfil:", error);
    if (entrouComGoogle) {
      showError(
        "Não foi possível concluir o cadastro. Verifique sua conexão e tente novamente.",
      );
      // Não deixar um Google login incompleto avançar após falha de gravação.
      await signOut(auth).catch((erro) =>
        console.warn("Falha ao encerrar sessão:", erro),
      );
    } else {
      // Mantém o comportamento anterior dos acessos por email e senha.
      window.location.replace("principal.html");
    }
  } finally {
    redirecionamentoEmAndamento = false;
  }
}

/**
 * Log de eventos
 */
function logEvent(eventName, eventData = {}) {
  console.log(`[Event] ${eventName}`, eventData);
  // Aqui você pode conectar a um serviço de analytics
}
