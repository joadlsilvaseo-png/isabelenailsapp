# Catálogo público -> autenticação -> agendamento

O site Isabele Mariana Nails direciona o botão de um serviço para:
`https://isabelenailsapp.vercel.app/login.html?servico=<id>`

O app interpreta apenas o ID de serviço em `catalogoEntrada.mjs`, não URLs externas.

Fluxos:
- Cliente sem sessão: faz login/cadastro; seu serviço é preservado.
- Cliente autenticada: o login detecta a sessão e segue o mesmo fluxo.
- Após login/cadastro: vai à Principal com `?servico=<id>`, que valida perfil e status antes de abrir `agendamento.html?id=<id>`.
- Administradoras: não são direcionadas automaticamente ao agendamento; acesso administrativo normal permanece.
- Conta inativa: a validação da Principal continua bloqueando o acesso.
- Entrada normal sem parâmetro: nenhuma mudança no comportamento.

Testes: `node --test scripts/catalogo-entrada.test.mjs`

Não se altera backend, PIX, pagamentos nem regras de agenda.
