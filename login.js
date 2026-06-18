import { trackEvent } from "./analytics.js";
import { auth, googleProvider, db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

import {
  signInWithEmailAndPassword,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

// ============================================================
// JAVASCRIPT - Página Login (login.html)
// ============================================================

document.addEventListener("DOMContentLoaded", function () {
  initializeLogin();
});

/**
 * Função de inicialização da página de login
 */
function initializeLogin() {
  console.log("Login page carregada");
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
function setupGoogleLogin() {
  const googleBtn = document.getElementById("googleLoginBtn");

  if (!googleBtn) return;

  googleBtn.addEventListener("click", async function () {
    console.log("[GOOGLE LOGIN] Clicado");

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;

      console.log("[GOOGLE LOGIN] Usuário autenticado");
      console.log("[GOOGLE LOGIN] UID:", user.uid);
      console.log("[GOOGLE LOGIN] Email:", user.email);
      console.log("[GOOGLE LOGIN] Nome:", user.displayName);

      // Verificar se documento existe na coleção clientes
      const userDocRef = doc(db, "clientes", user.uid);
      console.log(
        "[GOOGLE LOGIN] Verificando documento em clientes/" + user.uid,
      );
      const userDocSnapshot = await getDoc(userDocRef);
      console.log("[GOOGLE LOGIN] getDoc() executado");

      if (userDocSnapshot.exists()) {
        console.log("[GOOGLE LOGIN] Documento encontrado");
      } else {
        console.log(
          "[GOOGLE LOGIN] Documento não encontrado - criando novo documento",
        );

        try {
          await setDoc(userDocRef, {
            nome: user.displayName || "",
            email: user.email || "",
            telefone: "",
            role: "cliente",
            dataCadastro: new Date().toISOString(),
          });
          console.log("[GOOGLE LOGIN] Documento criado com sucesso");
        } catch (setDocError) {
          console.error("[GOOGLE LOGIN] Erro ao criar documento", setDocError);
        }
      }

      console.log("[Login] Sucesso");
      trackEvent("login");
      await redirectByRole(result.user);
    } catch (error) {
      console.error("[Google Login] Erro", error);
      showError(error.message || "Erro ao fazer login com Google");
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
  if (!user) return;
  try {
    const userRef = doc(db, "clientes", user.uid);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists() && userSnap.data().role === "admin") {
      window.location.href = "dashboard.html";
    } else {
      window.location.href = "principal.html";
    }
  } catch (error) {
    window.location.href = "principal.html";
  }
}

/**
 * Log de eventos
 */
function logEvent(eventName, eventData = {}) {
  console.log(`[Event] ${eventName}`, eventData);
  // Aqui você pode conectar a um serviço de analytics
}
