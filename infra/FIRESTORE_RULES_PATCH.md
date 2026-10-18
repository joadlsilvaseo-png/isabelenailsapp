# Ajuste necessário nas regras do Firestore

O checkout clonado não contém `firestore.rules`, `firebase.json` ou uma cópia das regras atualmente publicadas. Por isso, não substitua nem publique regras sem comparar este patch com a política existente do projeto.

## Mudança necessária antes de publicar o código

No escopo do serviço `cloud.firestore`, adicione o helper de administradora e, dentro do bloco existente `match /agendamentos/{agendamentoId}`, mantenha a regra de leitura atual e restrinja gravações feitas por SDKs de navegador a administradoras. O backend usa Firebase Admin SDK e não é afetado por estas regras.

```text
function isAdmin() {
  return request.auth != null && (
    (exists(/databases/$(database)/documents/usuarios/$(request.auth.uid)) &&
      get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data.role == 'admin' &&
      get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data.ativo == true) ||
    (!exists(/databases/$(database)/documents/usuarios/$(request.auth.uid)) &&
      exists(/databases/$(database)/documents/clientes/$(request.auth.uid)) &&
      get(/databases/$(database)/documents/clientes/$(request.auth.uid)).data.role == 'admin')
  );
}

match /agendamentos/{agendamentoId} {
  // Preserve aqui a regra de leitura que já permite consultar disponibilidade
  // e carregar a agenda administrativa.
  allow create, update, delete: if isAdmin();
}
```

As clientes criam e reagendam pela API autenticada. Cancelamentos também continuam no backend. A criação administrativa direta existente permanece permitida. A permissão de isenção fica no PostgreSQL; não grave um campo de autorização editável em `clientes/{uid}`.

Este arquivo é uma orientação de merge, não um arquivo completo de regras. A regra de leitura e as regras das demais coleções precisam permanecer conforme a configuração atual do projeto.
