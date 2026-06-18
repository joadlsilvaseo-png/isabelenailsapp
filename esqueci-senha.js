// Validação e envio simulado do formulário de recuperação de senha

// Verifica se um email tem formato válido
function validarEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

// Mostra mensagem de feedback (erro/serviço)
function mostrarFeedback(el, message, isError = true) {
  el.textContent = message;
  el.style.color = isError ? '#b53f60' : '#2a7a4a';
}

// Habilita / desabilita botão de envio
function setBotaoEstado(botao, estaHabilitado) {
  botao.disabled = !estaHabilitado;
  if (estaHabilitado) {
    botao.classList.remove('esqueci-button--disabled');
  } else {
    botao.classList.add('esqueci-button--disabled');
  }
}

// Comportamento principal ao tentar enviar o link
function enviarLink() {
  const inputEmail = document.getElementById('esqueci-email');
  const feedback = document.getElementById('esqueci-feedback');
  const botao = document.querySelector('.esqueci-button');

  // Limpa mensagens anteriores
  mostrarFeedback(feedback, '', true);

  const email = inputEmail.value.trim();

  // Valida campo vazio
  if (!email) {
    mostrarFeedback(feedback, 'Por favor, informe seu e-mail.', true);
    inputEmail.focus();
    return;
  }

  // Valida formato de email
  if (!validarEmail(email)) {
    mostrarFeedback(feedback, 'Formato de e-mail inválido. Ex: nome@exemplo.com', true);
    inputEmail.focus();
    return;
  }

  // Desabilita o botão para evitar cliques múltiplos
  setBotaoEstado(botao, false);
  botao.textContent = 'Enviando...';

  // Simula envio com timeout de 1500ms
  setTimeout(() => {
    // Feedback de sucesso
    mostrarFeedback(feedback, 'Enviamos um link de recuperação para seu e-mail.', false);
    botao.textContent = 'Enviar Link';

    // Permite usuário retornar ao login
    setBotaoEstado(botao, true);

    // Opcional: foco no link de login para facilitar retorno
    const linkLogin = document.querySelector('.esqueci-link');
    if (linkLogin) linkLogin.focus();

  }, 1500);
}

// Inicializa listeners quando DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
  const botao = document.querySelector('.esqueci-button');
  const inputEmail = document.getElementById('esqueci-email');

  if (!botao || !inputEmail) return;

  // Clique no botão "Enviar Link"
  botao.addEventListener('click', enviarLink);

  // Pressionar Enter no campo email também deve submeter
  inputEmail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      enviarLink();
    }
  });
});
