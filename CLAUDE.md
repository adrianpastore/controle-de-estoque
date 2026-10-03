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
- Testar mudanças numa **cópia do banco** (rodar o servidor em outra porta com `PORTA=3999`), nunca lançando testes no banco real.
- A planilha original tem uma **senha anotada na última linha**: nunca importar nem exibir essa linha.

## Como rodar

- Abrir o `iniciar.bat` (ou `npm start`). Porta **3000**.
- Neste PC: `http://localhost:3000`. Na rede (celular): `http://IP-do-Caixa03:3000` (o servidor mostra o IP ao iniciar; hoje `192.168.0.236`).
- **Mudança no servidor** (`src/`): fechar a janela e abrir o `iniciar.bat` de novo. **Mudança na tela** (`public/`): Ctrl+F5 no navegador basta.
- Scripts: `npm run importar` (planilha → banco, só com banco vazio; `-- --forcar` apaga tudo e reimporta) e `npm run empresas` (separa em empresas os produtos sem empresa; `-- --refazer` refaz todos e desfaz escolhas manuais).

## Stack

- **Node.js** (v24) + **Express**. Banco **SQLite embutido no Node** (`node:sqlite`), arquivo `dados/estoque.db`. Backup = copiar esse arquivo.
- Tela em **JavaScript puro, sem frameworks** (`public/`). Nomes de variáveis, funções e comentários em **português**.
- `exceljs` só para ler a planilha na importação.

## Estrutura

- `src/server.js`: rotas da API.
- `src/db.js`: tabelas e migrações (rodam sozinhas ao iniciar).
- `src/empresas.js`: regra que transforma o texto da coluna Fornecedor em empresa.
- `public/app.js`, `public/style.css`, `public/index.html`: a tela.
- `scripts/importar-planilha.js`, `scripts/separar-empresas.js`.
- `dados/` (banco, backups, relatório da importação) e a planilha `.xlsx` **não vão para o git**.

## Como o sistema funciona

- **Estoque = soma dos lotes.** Cada entrada cria um lote (com validade opcional). Saída tira primeiro do lote que vence antes.
- **Movimentações** guardam a quantidade com sinal: entrada +, saída −, ajuste = diferença ("contou X, sistema tinha Y").
- **Empresas = abas.** Vieram da coluna Fornecedor da planilha: grafias diferentes viram uma só (ex.: "fritz", "fritz e frida" → Fritz Frida). Com vários fornecedores, vale o primeiro. O texto original continua no campo `fornecedor`. As 6 maiores viram abas; o resto fica em "Mais empresas". Produto sem empresa fica na aba "Sem empresa", onde dá para escolher.
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
- [ ] Importar o **XML da NF-e**: lança as entradas da nota de uma vez (quantidade e custo). Na primeira vez, associar cada item da nota a um produto; o sistema lembra depois.

### Fase 3: controle e relatórios
- [ ] Validades e alertas ("vencendo nos próximos dias"); guardar todas as validades por lote, mostrar uma em destaque
- [ ] **Lista de pedido por empresa** para imprimir / mandar por WhatsApp
- [ ] Relatórios: consumo por período, compras, custo

### Fase 4: agilidade
- [ ] Código de barras pela câmera do celular
- [ ] Listas prontas (ex.: abastecimento do freezer)
- [ ] Download automático das notas pela **SEFAZ** com o certificado **A1** (já instalado no Caixa03)

### Pontos combinados em 03/10/2026 (fazer nesta ordem)
- [x] **1.5 Botão "Empresas"**: lista todas de A a Z com quantos produtos estão para pedir. As 6 maiores continuam como abas.
- [ ] **1.4 Caixa ou unidade**: cada produto ganha um fator (ex.: 1 cx = 12 und). O estoque é guardado na unidade menor e a tela mostra "3 cx + 4 und". Na entrada e na saída escolhe-se cx/fardo ou und. **Mínimo e Pedir continuam em caixa/fardo.** Mexe no banco: fazer antes do XML. Em 03/10/2026 o estoque foi **zerado** (lotes e histórico apagados; backup `dados/backup/antes-de-zerar-2026-10-03.db`) para alimentar do zero, então não há estoque antigo para converter.
- [ ] **1.3 Validades**: (a) corrigir ou excluir uma validade/lote lançado errado **e** (b) dar baixa em vencidos como perda (sai do estoque e fica registrado como "vencido").
- [ ] **1.2 Métodos de baixa**: baixa rápida na lista → baixa de vários produtos de uma vez → listas prontas → câmera (fase 4).
- [ ] **1.1 Entrada**: manual + XML da NF-e. IA por foto **não**: é paga e manda dados para a internet. Só reavaliar se o dono pedir.

**Ordem sugerida depois disso:** login → backup → IP fixo → lista de pedido → XML da NF-e.
