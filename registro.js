import { trackEvent } from "./analytics.js";
import { auth, db, googleProvider } from "./firebase-config.js";

import {
  createUserWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const PENDING_GOOGLE_PHONE_KEY = "pendingPhone";


/* ============================================================
   REGISTRATION PAGE - FORM VALIDATION & INTERACTIONS
   ============================================================ */

document.addEventListener("DOMContentLoaded", function () {
  initializeSignup();
});

function initializeSignup() {
  setupFormValidation();
  setupGoogleSignup();
  setupFieldListeners();
}

/* ============================================================
   FORM VALIDATION
   ============================================================ */

function setupFormValidation() {
  const form = document.getElementById("signupForm");

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    const name = document.getElementById("nameInput").value.trim();
    const email = document.getElementById("emailInput").value.trim();
    const phone = document.getElementById("phoneInput").value.trim();
    const password = document.getElementById("passwordInput").value;
    const confirmPassword = document.getElementById(
      "confirmPasswordInput",
    ).value;
    const termsCheckbox = document.getElementById("termsCheckbox").checked;

    // Reset errors
    clearErrors();

    // Validate inputs
    let isValid = true;

    if (!name || name.length < 3) {
      showError("nameInput", "Nome deve ter no mínimo 3 caracteres");
      isValid = false;
    }

    if (!isValidEmail(email)) {
      showError("emailInput", "Por favor, insira um e-mail válido");
      isValid = false;
    }

    if (!isValidPhone(phone)) {
      showError("phoneInput", "Por favor, insira um celular válido");
      isValid = false;
    }

    if (!password) {
      showError("passwordInput", "Senha é obrigatória");
      isValid = false;
    } else if (password.length < 6) {
      showError("passwordInput", "Senha deve ter no mínimo 6 caracteres");
      isValid = false;
    }

    if (!confirmPassword) {
      showError("confirmPasswordInput", "Confirmação de senha é obrigatória");
      isValid = false;
    } else if (password !== confirmPassword) {
      showError("confirmPasswordInput", "As senhas não conferem");
      isValid = false;
    }

    if (!termsCheckbox) {
      showError(
        "termsCheckbox",
        "Você deve concordar com os Termos e Condições",
      );
      isValid = false;
    }

    if (isValid) {
      performSignup(name, email, phone, password);
    }
  });
}

/* ============================================================
   FIELD LISTENERS
   ============================================================ */

function setupFieldListeners() {
  const inputs = document.querySelectorAll(".signup-input");

  inputs.forEach((input) => {
    input.addEventListener("focus", function () {
      clearError(this.id);
    });

    input.addEventListener("blur", function () {
      validateField(this);
    });
  });

  const checkbox = document.getElementById("termsCheckbox");
  checkbox.addEventListener("change", function () {
    if (this.checked) {
      clearError("termsCheckbox");
    }
  });
}

function openGooglePhoneModal(defaultPhone = "") {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "10000";

    const modal = document.createElement("div");
    modal.style.width = "min(420px, 90vw)";
    modal.style.backgroundColor = "#ffffff";
    modal.style.borderRadius = "16px";
    modal.style.boxShadow = "0 20px 50px rgba(0,0,0,0.2)";
    modal.style.padding = "24px";
    modal.style.display = "flex";
    modal.style.flexDirection = "column";
    modal.style.gap = "14px";

    modal.innerHTML = `
      <h2 style="margin:0;font-size:1.3rem;color:#1f1f1f;">Continue com Google</h2>
      <p style="margin:0;color:#575757;line-height:1.45;">Digite seu telefone para concluir o cadastro com Google.</p>
      <label style="display:flex;flex-direction:column;gap:8px;font-size:0.95rem;color:#333;">
        <span>Celular</span>
        <input id="googlePhoneInput" type="tel" value="${defaultPhone}" placeholder="(11) 99999-9999" style="width:100%;padding:12px 14px;border:1px solid #ccc;border-radius:10px;font-size:1rem;outline:none;" />
        <span id="googlePhoneError" style="display:none;color:#b00020;font-size:0.85rem;"></span>
      </label>
      <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:8px;">
        <button id="googlePhoneCancel" type="button" style="padding:12px 18px;border:none;background:transparent;color:#333;cursor:pointer;border-radius:10px;">Cancelar</button>
        <button id="googlePhoneContinue" type="button" style="padding:12px 18px;border:none;background:#4285f4;color:#fff;cursor:pointer;border-radius:10px;">Continuar com Google</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const phoneInput = modal.querySelector("#googlePhoneInput");
    const errorEl = modal.querySelector("#googlePhoneError");
    const cancelBtn = modal.querySelector("#googlePhoneCancel");
    const continueBtn = modal.querySelector("#googlePhoneContinue");

    function closeModal() {
      overlay.remove();
    }

    function validatePhone() {
      const value = phoneInput.value.trim();
      if (!isValidPhone(value)) {
        errorEl.textContent = "Por favor, insira um celular válido.";
        errorEl.style.display = "block";
        phoneInput.style.borderColor = "#b00020";
        return null;
      }
      return value;
    }

    phoneInput.addEventListener("input", () => {
      errorEl.style.display = "none";
      phoneInput.style.borderColor = "#ccc";
    });

    cancelBtn.addEventListener("click", () => {
      closeModal();
      reject(new Error("Modal cancelado"));
    });

    continueBtn.addEventListener("click", () => {
      const validPhone = validatePhone();
      if (!validPhone) return;
      closeModal();
      resolve(validPhone);
    });

    phoneInput.focus();
  });
}

/* ============================================================
   FIELD VALIDATION
   ============================================================ */

function validateField(field) {
  const value = field.value.trim();

  if (field.id === "nameInput") {
    if (value && value.length < 3) {
      showError("nameInput", "Nome deve ter no mínimo 3 caracteres");
    }
  } else if (field.id === "emailInput") {
    if (value && !isValidEmail(value)) {
      showError("emailInput", "E-mail inválido");
    }
  } else if (field.id === "phoneInput") {
    if (value && !isValidPhone(value)) {
      showError("phoneInput", "Celular inválido");
    }
  } else if (field.id === "passwordInput") {
    if (value && value.length < 6) {
      showError("passwordInput", "Senha deve ter no mínimo 6 caracteres");
    } else if (value) {
      // Check if confirm password needs validation
      const confirmPasswordField = document.getElementById(
        "confirmPasswordInput",
      );
      if (confirmPasswordField && confirmPasswordField.value) {
        if (value !== confirmPasswordField.value) {
          showError("confirmPasswordInput", "As senhas não conferem");
        } else {
          clearError("confirmPasswordInput");
        }
      }
    }
  } else if (field.id === "confirmPasswordInput") {
    const passwordField = document.getElementById("passwordInput");
    if (value && passwordField && passwordField.value) {
      if (value !== passwordField.value) {
        showError("confirmPasswordInput", "As senhas não conferem");
      } else {
        clearError("confirmPasswordInput");
      }
    }
  }
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidPhone(phone) {
  // Remove non-digits
  const digits = phone.replace(/\D/g, "");
  // Validate Brazilian phone format (11 digits)
  return digits.length >= 10 && digits.length <= 11;
}

/* ============================================================
   ERROR HANDLING
   ============================================================ */

function showError(fieldId, message) {
  const field = document.getElementById(fieldId);

  if (!field) return;

  field.classList.add("error");

  // Create error message element if not exists
  let errorEl = field.parentElement?.querySelector(".error-message");

  if (!errorEl) {
    errorEl = document.createElement("p");
    errorEl.className = "error-message";
    field.parentElement?.appendChild(errorEl);
  }

  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function clearError(fieldId) {
  const field = document.getElementById(fieldId);

  if (!field) return;

  field.classList.remove("error");

  const errorEl = field.parentElement?.querySelector(".error-message");
  if (errorEl) {
    errorEl.style.display = "none";
  }
}

function clearErrors() {
  document
    .querySelectorAll(".signup-input, .signup-checkbox")
    .forEach((field) => {
      field.classList.remove("error");
    });

  document.querySelectorAll(".error-message").forEach((el) => {
    el.style.display = "none";
  });
}

/* ============================================================
   FORM SUBMISSION
   ============================================================ */

async function performSignup(name, email, phone, password) {
  const submitBtn = document.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  // Show loading state
  submitBtn.disabled = true;
  submitBtn.textContent = "Cadastrando...";

  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      email,
      password,
    );

    await updateProfile(userCredential.user, {
      displayName: name,
    });

    const userDocRef = doc(db, "clientes", userCredential.user.uid);
    await setDoc(userDocRef, {
      nome: name,
      email: email,
      telefone: phone,
      dataCadastro: new Date().toISOString(),
    });

    logEvent("signup_attempt", {
      method: "email",
      email_domain: email.split("@")[1],
    });

    trackEvent("registro");

    alert("Cadastro realizado com sucesso!");

    submitBtn.disabled = false;
    submitBtn.textContent = originalText;

    // Reset form
    document.getElementById("signupForm").reset();

    // Redirect to principal page after success
    window.location.href = "principal.html";
  } catch (error) {
    console.error("Signup error:", error);

    const errorCode = error.code || "";
    if (errorCode === "auth/email-already-in-use") {
      showError("emailInput", "Este e-mail já está cadastrado.");
    } else if (errorCode === "auth/invalid-email") {
      showError("emailInput", "E-mail inválido.");
    } else if (errorCode === "auth/weak-password") {
      showError("passwordInput", "A senha deve ter pelo menos 6 caracteres.");
    } else if (errorCode === "auth/network-request-failed") {
      showError("emailInput", "Verifique sua conexão com a internet.");
    } else {
      showError("emailInput", "Erro ao criar conta. Tente novamente.");
    }

    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

/* ============================================================
   GOOGLE SIGNUP
   ============================================================ */

function setupGoogleSignup() {
  const googleBtn = document.getElementById("googleSignupBtn");

  googleBtn.addEventListener("click", async function () {
    logEvent("signup_attempt", { method: "google" });

    console.log("[GOOGLE SIGNUP] Clicado");

    let pendingPhone;
    try {
      pendingPhone = await openGooglePhoneModal(
        document.getElementById("phoneInput")?.value.trim() || "",
      );
      sessionStorage.setItem(PENDING_GOOGLE_PHONE_KEY, pendingPhone);
      console.log("[GOOGLE SIGNUP] Telefone temporário salvo em sessionStorage");
    } catch (modalError) {
      console.log("[GOOGLE SIGNUP] Modal cancelado ou fechado", modalError.message);
      return;
    }

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;

      console.log("[GOOGLE SIGNUP] Usuário autenticado");
      console.log("[GOOGLE SIGNUP] UID:", user.uid);
      console.log("[GOOGLE SIGNUP] Email:", user.email);
      console.log("[GOOGLE SIGNUP] Nome:", user.displayName);

      const userDocRef = doc(db, "clientes", user.uid);

      console.log(
        "[GOOGLE SIGNUP] Verificando documento em clientes/" + user.uid,
      );
      const userDocSnapshot = await getDoc(userDocRef);
      console.log("[GOOGLE SIGNUP] getDoc() executado");

      const userPayload = {
        nome: user.displayName || "",
        email: user.email || "",
        foto: user.photoURL || "",
      };

      if (pendingPhone) {
        userPayload.telefone = pendingPhone;
      }

      if (!userDocSnapshot.exists()) {
        console.log(
          "[GOOGLE SIGNUP] Documento não encontrado - criando novo documento",
        );
        userPayload.role = "cliente";
        userPayload.criadoEm = new Date().toISOString();
      } else {
        console.log("[GOOGLE SIGNUP] Documento já existe - atualizando com merge");
      }

      try {
        await setDoc(userDocRef, userPayload, { merge: true });
        console.log("[GOOGLE SIGNUP] Documento atualizado/criado com sucesso");
      } catch (setDocError) {
        console.error("[GOOGLE SIGNUP] Erro ao gravar documento", setDocError);
      }

      sessionStorage.removeItem(PENDING_GOOGLE_PHONE_KEY);
      console.log("[GOOGLE SIGNUP] pendingPhone removido do sessionStorage");

      logEvent("signup_success", { method: "google", user_id: user.uid });
      window.location.href = "principal.html";
    } catch (error) {
      console.error("[GOOGLE SIGNUP] Erro:", error);
      console.error("[GOOGLE SIGNUP] Erro code:", error.code);
      console.error("[GOOGLE SIGNUP] Erro message:", error.message);
      showError("googleSignupBtn", "Erro ao fazer login com Google");
      logEvent("signup_error", {
        method: "google",
        error: error.code || error.message,
      });
    }
  });
}

/* ============================================================
   ANALYTICS
   ============================================================ */

function logEvent(eventName, eventData = {}) {
  const data = {
    page: "signup",
    timestamp: new Date().toISOString(),
    ...eventData,
  };

  console.log(`[Analytics] ${eventName}:`, data);

  // TODO: Integrate with Firebase Analytics
  // firebase.analytics().logEvent(eventName, data);
}

/* ============================================================
   UTILITIES
   ============================================================ */

function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}
