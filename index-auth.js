import { auth, db } from "./firebase-config.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

let redirecionamentoEmAndamento = false;

async function redirecionarUsuarioAutenticado(user) {
  if (!user || redirecionamentoEmAndamento) {
    return;
  }

  redirecionamentoEmAndamento = true;

  try {
    /*
     * Mantemos clientes/{uid} por enquanto,
     * pois essa é a estrutura atual do aplicativo.
     */
    const perfilRef = doc(db, "clientes", user.uid);
    const perfilSnap = await getDoc(perfilRef);

    const role = perfilSnap.exists() ? perfilSnap.data().role : "cliente";

    if (role === "admin") {
      window.location.replace("dashboard.html");
      return;
    }

    window.location.replace("principal.html");
  } catch (error) {
    console.error("[Index] Erro ao verificar usuário autenticado:", error);

    window.location.replace("principal.html");
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    console.log("[Index] Nenhuma sessão autenticada encontrada.");
    return;
  }

  console.log("[Index] Sessão restaurada:", user.uid);

  await redirecionarUsuarioAutenticado(user);
});
