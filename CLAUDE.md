# Controle de Estoque da Padaria

## Objetivo

Substituir a planilha "Estoque Padaria" por um sistema simples, usado no celular e no computador da padaria:
- O estoquista lança **entradas**, **saídas** e **ajustes** (contou e arruma para o valor certo).
- O sistema mostra sozinho **o que pedir** e **para qual empresa**.
- Saída = abastecimento dos freezers / consumo interno (**não é venda**).

## Regras importantes

- **Custo zero.** Nada de serviço pago (nem API paga de IA). Qualquer coisa que gere custo deve ser avisada antes.
- **Tudo local.** O servidor roda no PC **Caixa03** (fica sempre ligado) e é acessado pela rede da padaria. Não sai para a internet.
- **Passo a passo:** o dono quer testar cada etapa antes de seguir para a próxima.
- **Explicações em português, simples.** Visual em **tons escuros**, funcionando bem no celular e no PC.
- **Antes de mexer no banco real** (migração, script, separação em massa), fazer backup em `dados/backup/`.
- Testar mudanças numa **cópia do banco**: `BANCO=C:\temp\copia.db PORTA=3999 npm start` (cópia feita com `VACUUM INTO`), nunca lançando testes no banco real. Testes automáticos: `npm test` (sobem o servidor num banco vazio temporário).
- A planilha original tem uma **senha anotada na última linha**: nunca importar nem exibir essa linha.

## Onde está e como continuar de outro computador

- Código: **https://github.com/adrianpastore/controle-de-estoque** (branch `main`). Commit ao fim de cada etapa.
- **O banco não vai para o git** (`dados/` está no `.gitignore`): os dados reais só existem no **Caixa03**, em `dados/estoque.db`. Em outro PC, `git clone` + `npm install` + `npm start` cria um banco **vazio** (as tabelas se criam sozinhas). Para ter produtos lá, copiar o `estoque.db` do Caixa03 (ou rodar `npm run importar` com a planilha `Estoque Padaria.xlsx`, que também fica fora do git).
- Mexeu no código em outro PC: commit + push lá, e no Caixa03 só `git pull`. O gancho `.githooks/post-merge` (ligado pelo `iniciar.bat` com `core.hooksPath`) roda `scripts/atualizar.js`: instala as bibliotecas se o `package-lock.json` mudou, mostra a situação do certificado e encerra o servidor; o `iniciar.bat` (em laço) sobe de novo com a versão nova, e as migrações de `src/db.js` rodam sozinhas (com backup automático).
- Certificado da SEFAZ no Caixa03: `configurar-sefaz.bat` (acha o .pfx ou exporta o do Windows, confere a senha e grava `dados/config.json`).
- No Caixa03 o git não está no PATH: usar `"C:\Program Files\Git\cmd\git.exe"`.

## Como rodar

- Abrir o `iniciar.bat` (ou `npm start`). Porta **3000**.
- Neste PC: `http://localhost:3000`. Na rede (celular): `http://IP-do-Caixa03:3000` (o servidor mostra o IP ao iniciar; hoje `192.168.0.236`).
- **Mudança no servidor** (`src/`): fechar a janela e abrir o `iniciar.bat` de novo. **Mudança na tela** (`public/`): Ctrl+F5 no navegador basta.
- Scripts: `npm run vendor` (copia o leitor de código de barras para `public/vendor/`, depois de atualizar a `@zxing/library`), `npm run importar` (planilha → banco, só com banco vazio; `-- --forcar` apaga tudo e reimporta) e `npm run empresas` (separa em empresas os produtos sem empresa; `-- --refazer` refaz todos e desfaz escolhas manuais).

## Stack

- **Node.js** (v24) + **Express**. Banco **SQLite embutido no Node** (`node:sqlite`), arquivo `dados/estoque.db`. Backup = copiar esse arquivo.
- Tela em **JavaScript puro, sem frameworks** (`public/`). Nomes de variáveis, funções e comentários em **português**.
- `exceljs` só para ler a planilha na importação.

## Estrutura

- `src/server.js`: rotas de produtos, empresas e lançamento manual; carrega as outras de `src/rotas/` (validades, baixa, nfe).
- `src/estoque.js`: contas comuns (lotes, formatar, transação). `src/nfe-xml.js`: leitura do XML da NF-e. `src/sefaz.js`: download do XML na SEFAZ com o certificado A1.
- `src/db.js`: tabelas e migrações (rodam sozinhas ao iniciar).
- `src/empresas.js`: regra que transforma o texto da coluna Fornecedor em empresa.
- `public/app.js`, `public/style.css`, `public/index.html`: a tela (lista e ficha do produto, rotas em `PAGINAS`). `public/validades.js`, `public/baixa.js`, `public/nfe.js` (+ `.css`): as outras páginas.
- `tests/`: testes automáticos (`node:test`) e notas fictícias em `tests/fixtures/`.
- `scripts/importar-planilha.js`, `scripts/separar-empresas.js`.
- `dados/` (banco, backups, relatório da importação) e a planilha `.xlsx` **não vão para o git**.

## Como o sistema funciona

- **Estoque = soma dos lotes.** Cada entrada cria um lote (com validade opcional). Saída tira primeiro do lote que vence antes.
- **Caixa x unidade (`fator`, `unidade_menor`):** produto com fator (ex.: 1 cx = 12 und) guarda lotes e movimentações **na unidade menor**; a tela mostra "3 cx + 4 und" e o lançamento tem dois campos (cx e und soltas, pode usar um ou os dois). Sem fator, tudo fica na unidade do produto, como antes. Na API, `estoque_base` = como está nos lotes e `estoque` = na unidade do produto (= `estoque_base / fator`). **Mínimo e Pedir são sempre na unidade do produto** (cx/fardo); com fator, o Pedir arredonda para cima (caixas inteiras). Ligar/desligar o fator na ficha converte os lotes e o histórico daquele produto; trocar um fator por outro (12 → 24) mantém as unidades.
- O texto da quantidade é montado igual em dois lugares: `formatar` (src/server.js) e `qtdProduto` (public/app.js).
- **Movimentações** guardam a quantidade com sinal: entrada +, saída −, ajuste = diferença ("contou X, sistema tinha Y"), **perda** − (baixa de vencido) e **correcao** = diferença (lote corrigido ou excluído na ficha).
- **Validades:** na ficha, cada lote tem Corrigir, Excluir e (se vencido) Baixa como vencido. Página **Validades**: vencidos (baixa em todos) e os que vencem em 3/7/15/30 dias.
- **Baixa:** botão "− Baixa" em cada produto da lista; página **Baixa** com carrinho de vários produtos (tudo ou nada: se faltar estoque em um, nada é lançado; o carrinho fica no aparelho) e **listas prontas** (`listas`, `lista_itens`).
- **Entrada pela nota (página Entrada):** importar o XML da NF-e, ou ler a chave pela **foto do DANFE** (código de barras lido no próprio celular com a zxing; a foto não é guardada nem enviada) ou digitada, e baixar o XML na SEFAZ (NFeDistribuicaoDFe, com Ciência da Operação quando só vem o resumo). Na conferência, cada item da nota é ligado a um produto (lembrado em `nfe_associacoes` por CNPJ + código do fornecedor; `multiplicador` na unidade dos lotes) ou ignorado; lançar cria um lote por item com `custo_unit` e `nota_id`. A mesma chave não é lançada duas vezes.
- **Certificado A1:** `dados/config.json` (fora do git; modelo em `config.exemplo.json`): caminho do .pfx, senha, CNPJ, UF 43. A SEFAZ bloqueia por 1 hora quem consulta demais (erro 656). Situação em `/api/sefaz/status`. **A conexão real com a SEFAZ ainda não foi testada** (só com respostas simuladas): testar no Caixa03.
- Migrações fazem backup sozinhas antes de mexer em dados (`dados/backup/antes-…`).
- **Empresas = abas.** Vieram da coluna Fornecedor da planilha: grafias diferentes viram uma só (ex.: "fritz", "fritz e frida" → Fritz Frida). Com vários fornecedores, vale o primeiro. O texto original continua no campo `fornecedor`. As 6 maiores viram abas; o botão **"Empresas"** lista todas de A a Z com quantos produtos estão para pedir (`pedir` em `/api/empresas`). Produto sem empresa fica na aba "Sem empresa", onde dá para escolher.
- **Pedir é automático:** quando estoque < mínimo, pedir = mínimo − estoque (mesma conta da planilha). A caixinha "Pedir mesmo sem estar abaixo do mínimo" (`em_falta`) é a marcação manual e se desmarca sozinha quando entra mercadoria.
- **"Tem bastante"** (`nao_contado`): produto não contado; não entra no Pedir. Um ajuste tira essa marca.
- Mínimo e unidade podem ser editados direto na lista.

## Etapas

### Fase 1: base
- [x] Produtos, importação da planilha, histórico
- [x] Abas por empresa (a partir da coluna Fornecedor)
- [x] Lançamento manual: entrada, saída e ajuste
- [x] Pedir automático (mínimo − estoque)
- [x] Mínimo e unidade editáveis na lista; excluir produto
- [ ] **Login com perfis**: admin (dono) faz tudo; estoquista lança. Registrar **quem** fez cada lançamento. **Excluir produto só para o admin** (hoje qualquer um da rede consegue).
- [ ] **Backup automático** diário do banco
- [ ] **IP fixo** do Caixa03 (reserva no roteador)
- [ ] Limpeza dos dados (feita pelo dono na tela): mínimos, unidades, "Sem empresa", produtos marcados "Revisar"

### Fase 2: nota fiscal
- [x] Importar o **XML da NF-e**: lança as entradas da nota de uma vez (quantidade e custo). Na primeira vez, associar cada item da nota a um produto; o sistema lembra depois.

### Fase 3: controle e relatórios
- [ ] Validades e alertas ("vencendo nos próximos dias"); guardar todas as validades por lote, mostrar uma em destaque
- [ ] **Lista de pedido por empresa** para imprimir / mandar por WhatsApp
- [ ] Relatórios: consumo por período, compras, custo

### Fase 4: agilidade
- [ ] Código de barras pela câmera do celular
- [ ] Listas prontas (ex.: abastecimento do freezer)
- [ ] Download automático de todas as notas pela **SEFAZ** (hoje baixa uma nota pela chave, quando se fotografa ou digita) com o certificado **A1** (já instalado no Caixa03)

### Pontos combinados em 03/10/2026 (fazer nesta ordem)
- [x] **1.5 Botão "Empresas"**: lista todas de A a Z com quantos produtos estão para pedir. As 6 maiores continuam como abas.
- [x] **1.4 Caixa ou unidade**: feito (ver "Como o sistema funciona"). Testado só pela API numa cópia do banco; **falta o dono testar na tela** e preencher o fator nos produtos que precisam. Em 03/10/2026 o estoque foi **zerado** (lotes e histórico apagados; backup `dados/backup/antes-de-zerar-2026-10-03.db`) para alimentar do zero, então não há estoque antigo para converter.
- [x] **1.3 Validades**: corrigir ou excluir lote; baixa de vencidos como perda (13/10/2026).
- [x] **1.2 Métodos de baixa**: baixa rápida na lista, baixa de vários e listas prontas (13/10/2026). Câmera fica para a fase 4.
- [x] **1.1 Entrada**: manual + XML da NF-e + foto do DANFE (lê a chave e baixa o XML da SEFAZ) (13/10/2026). IA lendo a foto (nuvem) fica para uma atualização futura, se o dono pedir.

**Próximo passo:** o dono testar 1.3, 1.2 e 1.1 na tela; configurar o certificado no Caixa03 e testar a SEFAZ com uma nota real.

**Ordem sugerida depois disso:** login → backup → IP fixo → lista de pedido → XML da NF-e.
