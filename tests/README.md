# Testes de estoque

Cobertura de a32b006, 44ea3dd e b27ad40 na árvore de trabalho atual:
migração com backup e reinício, lançamento manual e consumo por validade,
correções/exclusões/perdas de lotes, consulta de validades, baixa em lote
atômica, produtos repetidos, conversão de caixas/unidades e CRUD de listas.
As verificações de saldo comparam API, soma dos lotes e soma de todo o
histórico no SQLite (sem depender do limite de 30 movimentos da ficha).

Execução normal solicitada:

```powershell
node --test tests/
```

Neste sandbox Windows com Node 24.20.0, o comando acima falha com
`spawn EPERM`. `node --test --test-isolation=none tests/` também falha,
com `ERR_UNSUPPORTED_DIR_IMPORT`. Usar o arquivo explicitamente:

```powershell
node --test --test-isolation=none tests/estoque.test.mjs
```

O helper tenta iniciar `node src/server.js` com BANCO e PORTA. Se o
sandbox bloquear também esse spawn com EPERM, carrega o arquivo original
no processo de testes e captura o servidor Express para encerrá-lo. Não
edita produção. Os testes deste arquivo são sequenciais; o fallback
compartilha variáveis de ambiente e cache CommonJS e não deve ser usado
com concorrência dentro do mesmo processo.

Cada cenário cria uma pasta com `mkdtemp` em `os.tmpdir()`, usa apenas
seu banco de teste e uma porta entre 3994 e 4000. O `after` fecha servidor
e banco e apaga a pasta, inclusive quando um teste falha. O banco antigo
da migração é construído pelo próprio teste. Nenhum teste importa o
módulo de banco sem antes configurar BANCO; dados/estoque.db não é usado.

Estes são testes de integração da API e persistência; não automatizam
interações com a tela no navegador.
