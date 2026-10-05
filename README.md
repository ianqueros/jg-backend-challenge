# Jungle Wagering

Processador financeiro de apostas com três instâncias NestJS, PostgreSQL e SQS. HTTP e mensagens usam o mesmo fluxo financeiro. O banco mantém saldo, ledger, resultado idempotente e eventos na mesma transação; workers cuidam de referências fora de ordem e publicação após o commit.

Este documento explica como executar, integrar e verificar a solução. O [CHALLENGE.md](CHALLENGE.md) contém o enunciado; o [ARCHITECTURE.md](ARCHITECTURE.md) registra as escolhas, as garantias e seus limites.

> **Ambiente local, sem autenticação.** O `providerId` recebido por HTTP seleciona o provedor, mas não comprova sua identidade nem autoriza acesso à wallet. Credenciais e segredos fornecidos são apenas locais. O Compose publica portas no host e não está preparado para exposição à internet. O desenho de autenticação está na arquitetura.

## 1. Executar o sistema

### Pré-requisitos

- Docker Engine e Docker Compose v2. A campanha `acceptance:fresh` requer Compose **2.24.4 ou superior**, com suporte a `!override`.
- Bun **1.3.10**, versão fixada no projeto, para comandos no host e testes. O build Docker já usa essa versão.
- Portas livres conforme a tabela abaixo. Os comandos deste documento usam a raiz do projeto como diretório de trabalho.

### Stack completo

```sh
docker compose -f compose.services.yaml -f compose.apps.yaml up -d --build --wait
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

O sistema usa dois arquivos Compose: `compose.services.yaml` define PostgreSQL, LocalStack e volumes; `compose.apps.yaml` define migrations, criação das filas, três aplicações e Nginx. Os dois arquivos formam um único projeto e não dependem de `.env` para esta execução.

As aplicações iniciam após as migrations e a configuração das filas. Cada réplica executa os três workers. Os ambientes principal e de testes compartilham as definições, mas têm portas e volumes separados.

| Acesso no host               | Principal               | Testes isolados              |
| ---------------------------- | ----------------------- | ---------------------------- |
| HTTP via Nginx               | `http://127.0.0.1:3000` | `http://127.0.0.1:3100`      |
| PostgreSQL                   | `5432`, banco `jungle`  | `55432`, banco `jungle_test` |
| LocalStack / SQS             | `4566`                  | `4567`                       |
| Aplicações, para diagnóstico | `3001`, `3002`, `3003`  | `3101`, `3102`, `3103`       |
| Projeto Compose              | `jungle-wagering`       | `jungle-wagering-test`       |

O gateway é o ponto de entrada do tráfego HTTP comum. As portas diretas permitem verificar cada réplica; não constituem uma barreira de segurança.

### Tecnologias adotadas

| Componente             | Versão fixada                      | Uso na solução                                                            |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| Bun / TypeScript       | `1.3.10` / `5.9.3`                 | Runtime, dependências, testes e tipagem estrita                           |
| NestJS com Express     | `11.2.7`                           | HTTP e composição dos módulos                                             |
| PostgreSQL             | `16.6-alpine`                      | Estado financeiro, constraints, inbox e outbox                            |
| MikroORM               | `6.6.17`                           | Mapeamento de registros, leituras, inserções gerenciadas e migrations SQL |
| Decimal.js / Zod       | `10.6.0` / `4.6.5`                 | Dinheiro exato e validação dos contratos                                  |
| AWS SDK SQS            | `3.1146.0`                         | Transporte de comandos e eventos                                          |
| LocalStack persistente | `gresau/localstack-persist:4.14.0` | SQS local com persistência                                                |
| Nginx                  | `1.28.0-alpine`                    | Distribuição entre três aplicações, sem retry automático de upstream      |
| Playwright             | `1.63.0`                           | Testes de API pelo gateway, sem interface gráfica                         |

As versões estão fixadas em [package.json](package.json), [Dockerfile](Dockerfile), [compose.services.yaml](compose.services.yaml) e [compose.apps.yaml](compose.apps.yaml).

## 2. Orientações para integração

Os corpos e endpoints de referência estão na seção 9 do [enunciado](CHALLENGE.md#9-api-http). As decisões específicas desta implementação são:

- Valores monetários entram como strings com **exatamente duas casas**, sem sinal, espaços, notação científica ou zeros extras à esquerda. Moedas aceitas: `BRL`, `USD` e `EUR`, sem conversão.
- `version` da wallet e `walletVersion` são **strings**, para preservar o intervalo de `BIGINT`. Dinheiro nas consultas e no ledger usa objetos `{ amount, currency }`, sem aliases monetários planos.
- `Idempotency-Key` é obrigatório, único no conjunto de headers, com 1–256 caracteres ASCII visíveis e sem espaços. O replay requer a chave e o payload originais.
- Campos financeiros desconhecidos e referência `null` são inválidos. Uma referência opcional ausente é representada pela omissão do campo.
- O corpo JSON tem limite de **100 KiB** na aplicação. O Nginx tem um teto adicional de **1 MiB**. Ambos usam erro seguro HTTP 413.
- Abertura positiva produz `OPENING`, ledger e eventos; abertura zero não produz esses registros. A versão inicial é sempre `"1"`.

### Como interpretar uma resposta

| Situação                                    | HTTP          | Significado                                                   |
| ------------------------------------------- | ------------- | ------------------------------------------------------------- |
| Wallet criada                               | `201`         | Identificador disponível para consultas e operações           |
| Transação `PROCESSED`                       | `200`         | Resultado financeiro confirmado                               |
| Transação `PENDING_REFERENCE`               | `202`         | Pendência persistida; o worker retoma a mesma operação        |
| Transação `REJECTED`                        | `422`         | Rejeição terminal identificada por `failureCode`              |
| Transação persistida `FAILED`               | `500`         | Falha terminal registrada                                     |
| Entrada inválida / corpo excessivo          | `400` / `413` | Requisição rejeitada na validação de entrada                  |
| Recurso ausente em consulta                 | `404`         | Identidade consultada não encontrada                          |
| Conflito de identidade ou wallet duplicada  | `409`         | Conflito com registro existente, distinto de replay           |
| Infraestrutura transitória / commit incerto | `503`         | Recuperação por consulta ou reenvio com a identidade original |
| Erro interno não classificado               | `500`         | Erro sem confirmação de rollback                              |

Rejeições e falhas **persistidas** retornam um resultado financeiro com `transactionId`, `status` e `failureCode`. Exceções usam `{ category, code, message }`, sem SQL, stack ou causa interna. A categoria `AuthenticationError` corresponde a 401, mas sua existência não significa que o modo local autentique clientes.

**Commit incerto:** `DATABASE_COMMIT_OUTCOME_UNKNOWN` significa que a confirmação foi perdida, não que a transação falhou. A recuperação usa consulta por provedor e ID externo ou reenvio da chave e do corpo originais. Um 404 durante essa recuperação não prova rollback de um commit ainda em andamento.

**Replay:** o resultado terminal retorna o saldo observado na execução original, não o saldo atual. Uma pendência pode evoluir até um resultado terminal. Outra chave para o mesmo ID externo retorna `WAGER_EXTERNAL_IDENTITY_CONFLICT`, mesmo se o payload for igual.

A taxonomia de rejeições está no [ARCHITECTURE.md](ARCHITECTURE.md#7-codigos-de-falha).

### Consultas e reconciliação

- A consulta de wallet mostra o saldo atual. As consultas de transação, por ID interno ou por provedor/ID externo, mostram o registro e seu resultado histórico; não expõem hashes, chaves de idempotência ou tokens de posse.
- O ledger retorna `{ items, nextCursor, hasMore }`. O limite padrão é 50 e o máximo é 200. `nextCursor` é opaco e é enviado na próxima consulta com codificação de URL. Novos lançamentos ficam fora de uma navegação já iniciada.
- A rota de reconciliação reconstrói o saldo pelo ledger, compara com o saldo materializado e registra eventuais divergências na resposta, nos logs e nas métricas. Retorna HTTP 200 tanto para consistência quanto para divergência; **`consistent`** distingue os dois resultados. `difference = storedBalance - calculatedBalance`. Por decisão de projeto, não executa reparo automático.

### Entrada e saída SQS

A fila `wager-transactions.fifo` recebe o envelope da seção 10 do enunciado. O contrato de transporte usa `walletId` como `MessageGroupId` e um `MessageDeduplicationId` estável derivado do `messageId` lógico. Dentro de `data`, `idempotencyKey` tem as mesmas regras do header HTTP.

| Fila                          | Papel                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| `wager-transactions.fifo`     | Comandos; redrive após o limite configurado de recebimentos |
| `wager-transactions-dlq.fifo` | Mensagens permanentes ou esgotamento do redrive             |
| `wager-events.fifo`           | Eventos publicados pela outbox                              |

O `messageId` do envelope identifica a mensagem na inbox; o `MessageId` atribuído pelo SQS identifica a entrega no broker. Reenvios da mesma mensagem lógica preservam seu conteúdo. O bootstrap configura as filas sem fazer purge.

A fila de eventos é observada pelos testes e não tem consumidor de negócio no stack. A integração com consumidores externos requer deduplicação persistente por `eventId`, pois a entrega permite duplicatas. A arquitetura descreve as versões dos eventos e os limites de ordenação.

## 3. Testes e evidências

### Campanha completa

```sh
bun install --frozen-lockfile
bun run acceptance
```

A campanha executa qualidade, build, subida do stack de testes, testes unitários, integração, API, recuperação de falhas e instalação limpa com reinício.

> As campanhas usam um ambiente local dedicado e execução **sequencial**. `acceptance:recovery` interrompe PostgreSQL e SQS, pausa ou encerra aplicações e instala temporariamente triggers de teste. Essas alterações interferem em outras suítes e em operações manuais no mesmo stack. `acceptance:fresh` cria um projeto isolado e remove seus próprios volumes ao terminar.

### Execuções focadas

```sh
# Dependências e aplicações isoladas do ambiente principal:
docker compose --env-file docker/test.env up -d --build --wait

bun run quality            # TypeScript, ESLint, Prettier, Knip e dependency-cruiser
bun run build              # Compilação e cópia do SQL das migrations para dist
bun run test               # Testes unitários, sem containers
bun run test:integration   # Integração com PostgreSQL e SQS reais
bun run test:api           # HTTP pelo Nginx, com três réplicas
bun run test:all           # Testes unitários, de integração e de API
bun run acceptance:recovery
bun run acceptance:fresh
bun run test:load           # Carga curta em um projeto isolado
```

O arquivo `docker/test.env` configura o projeto `jungle-wagering-test`, o banco `jungle_test`, as portas de teste e os limites SQL de 1.000 ms para locks e 2.000 ms por instrução. Os [scripts de teste](scripts/test-environment.ts) fixam esses destinos e substituem os valores do `.env` da aplicação. Um valor divergente em `TEST_*` interrompe a execução antes de abrir conexões ou controlar containers; as URLs já fazem parte da configuração.

O Playwright executa um cenário por vez. Dentro dos cenários, as chamadas concorrentes continuam simultâneas, inclusive as 50 cópias da mesma aposta. Isso separa a verificação de correção da disputa de recursos entre suítes independentes.

### Demonstrado

A campanha completa passou com **193 testes unitários, 189 de integração e 61 de API: 443 no total**, além de qualidade, build, recuperação e instalação limpa.

| Evidência registrada                           | Resultado observado                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| 50 cópias concorrentes de uma aposta           | Uma aplicação, 49 replays, um único efeito financeiro                              |
| Duas apostas de `80.00` contra `100.00`        | Uma processada, uma rejeitada, saldo `20.00` e um débito                           |
| Morte após commit e antes do ack               | Redelivery com replay, sem novo débito                                             |
| Morte após envio do evento e antes da marcação | Recuperação da publicação com os IDs originais                                     |
| Indisponibilidade do broker                    | Commit financeiro preservado; eventos entregues após recuperação                   |
| Reinício completo                              | Replay histórico preservado, comando retido aplicado uma vez e ledger reconciliado |

A campanha de testes usa limites de SQL diferentes dos limites principais, indicados abaixo.

### Cenários de carga

Os cenários e resultados estão em [Métricas de carga](docs/load-testing-metrics.md).

## 4. Configuração e desenvolvimento

O modelo [.env.example](.env.example) contém as cinco variáveis exigidas na inicialização: `DATABASE_URL`, `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`. `LEDGER_CURSOR_SECRET`, a chave usada para assinar os cursores da paginação do ledger com HMAC-SHA256, é opcional e usa um padrão local público. Os demais ajustes também têm valores padrão no código. Para a execução no host, o exemplo ativa os três workers e define `DB_INSTANCE_COUNT=1`.

Os arquivos Compose definem o ambiente dos containers, sem carregar o `.env` por `env_file`. As substituições explícitas permitem configurar portas e banco por `JUNGLE_*`, o segredo dos cursores por `LEDGER_CURSOR_SECRET` e os dois limites de tempo SQL. Outras variáveis do host não substituem essas definições. Os testes usam `docker/test.env` e volumes separados por projeto.

### Executar uma aplicação no host

Esta alternativa executa PostgreSQL e LocalStack em containers, com uma aplicação no host. A porta 3000 fica disponível para a aplicação quando o Nginx não está em execução.

```sh
bun install --frozen-lockfile
docker compose -f compose.services.yaml up -d --wait
cp -n .env.example .env
bun run db:up
bun run queues:bootstrap
bun run dev
# Sem watch: bun run start
```

Os três workers estão ativos no modelo do host. Cada flag em `false` desativa apenas o worker correspondente.

### Limites que afetam a operação

| Configuração                                           | Principal / host                       | Testes          |
| ------------------------------------------------------ | -------------------------------------- | --------------- |
| `DB_POOL_MAX` por processo                             | `10`                                   | `10`            |
| `DB_INSTANCE_COUNT`                                    | `3` no Compose; `1` no exemplo do host | `3`             |
| `DB_CONNECTION_BUDGET`                                 | `60`                                   | `60`            |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` | `1000` / `1000`                        | Iguais          |
| `DB_LOCK_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS`       | `250` / `1000`                         | `1000` / `2000` |
| `OPERATION_TIMEOUT_MS` / `DB_TRANSACTION_MAX_ATTEMPTS` | `5000` / `3`, incluindo a primeira     | Iguais          |
| `DB_RETRY_BASE_DELAY_MS` / `DB_RETRY_MAX_DELAY_MS`     | `10` / `100`, com jitter               | Iguais          |

Três pools de dez conexões usam até 30 das 60 conexões do orçamento configurado; PostgreSQL permite 100 conexões. O dimensionamento depende do número de processos e do limite por pool. Os limites maiores do stack de testes acomodam a campanha concorrente em estação compartilhada; não demonstram o mesmo comportamento de latência sob os limites principais.

| Worker             | Valores padrão relevantes                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Comandos           | Long-poll de 20 s; visibilidade de 30 s; renovação a cada 10 s; retry de 1 s até 60 s; redrive com `COMMAND_MAX_RECEIVE_COUNT=5` |
| Referências        | TTL de 24 h; polling de 1 s; lease de 30 s; backoff de 1 s até 60 s                                                              |
| Outbox             | Polling de 250 ms; lote de 10; lease de 30 s; backoff de 1 s até 60 s, sem limite de tentativas                                  |
| Chamadas ao broker | Prazo de 5 s por chamada; sem retries automáticos do SDK                                                                         |
| Encerramento       | `SHUTDOWN_GRACE_MS=30000`; Compose permite 40 s                                                                                  |

`LEDGER_CURSOR_SECRET` é o segredo compartilhado pelas réplicas para assinatura dos cursores e tem no mínimo 32 caracteres. Sua rotação invalida os cursores emitidos.

## 5. Operação e diagnóstico

```sh
docker compose -f compose.services.yaml -f compose.apps.yaml ps
docker compose -f compose.services.yaml -f compose.apps.yaml logs --tail=100 app-1 app-2 app-3
curl --fail http://127.0.0.1:3000/health/ready
curl --fail http://127.0.0.1:3001/metrics

# Parada e reinício com preservação dos volumes:
docker compose -f compose.services.yaml -f compose.apps.yaml stop
docker compose -f compose.services.yaml -f compose.apps.yaml up -d --wait

# Migrations e criação das filas com as configurações dos containers:
docker compose -f compose.services.yaml -f compose.apps.yaml run --rm migrate
docker compose -f compose.services.yaml -f compose.apps.yaml run --rm bootstrap-queues
```

Os comandos de operação também aceitam `docker compose --env-file docker/test.env <comando>` para o ambiente de testes, como `ps` ou `stop`. No host, `db:up` e `db:down` usam o `DATABASE_URL` configurado.

> **Remoção de dados:** `bun run db:down` remove o schema inicial. `down --volumes` remove os volumes do projeto selecionado; `stop` e `up` preservam os dados. O ambiente principal mantém `jungle-wagering_postgres_data` e `jungle-wagering_localstack_data`. Os testes usam `jungle-wagering-test_postgres_data` e `jungle-wagering-test_localstack_data`; os volumes anteriores de teste não foram removidos.

### Sinais de diagnóstico

| Sinal                                          | Interpretação                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/health/live` responde; `/health/ready` falha | Readiness depende do PostgreSQL, das três filas e do estado de shutdown; liveness não depende deles                   |
| HTTP 503                                       | O código seguro identifica a falha; a recuperação preserva a identidade da operação                                   |
| `PENDING_REFERENCE` prolongado                 | A resolução depende do provedor, do ID externo, do estado da referência e do worker ativo; replay não renova o TTL    |
| `outbox_pending_age_seconds` aumenta           | O evento mais antigo continua sem publicação; publisher, acesso ao SQS, claims e retries são os pontos de diagnóstico |
| DLQ recebe mensagens                           | Entregas inválidas, conflitos permanentes ou esgotamento do redrive; a causa determina a possibilidade de recuperação |
| Reconciliação retorna `consistent: false`      | Divergência entre wallet e ledger, registrada na resposta, nos logs e nas métricas; a rota não faz reparo automático  |

Logs financeiros são JSON, com os IDs conhecidos de correlação, transação, wallet, provedor e mensagem. Não incluem valores financeiros, payloads completos ou segredos. `messageId` lógico e `brokerMessageId` de transporte são distintos.

`GET /metrics` expõe `financial_status_total`, `financial_duplicate_total`, `financial_retry_total`, `financial_conflict_total`, `financial_dlq_total`, `outbox_publish_total`, os histogramas `financial_processing_seconds` e `outbox_delay_seconds`, além dos contadores de reconciliação.

Contadores e histogramas são **locais a cada réplica** e reiniciam com o processo. A coleta por réplica preserva essa distinção; o gateway distribui as consultas entre processos. Já `outbox_pending_age_seconds` consulta o mesmo banco em todas as réplicas: somar seus valores duplicaria a medição. O gauge inclui leases e retries futuros, retorna zero sem pendências e retorna erro em caso de falha SQL.

## 6. Navegar no código

| Ponto de entrada                                                       | Responsabilidade                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [FinancialUseCase](src/domains/wagering/financial.use-case.ts)         | Decisão financeira compartilhada, replay e retomada de referências    |
| [WalletUseCase](src/domains/wallet/wallet.use-case.ts)                 | Abertura, consultas e paginação do ledger                             |
| [ReconciliationUseCase](src/domains/wallet/reconciliation.use-case.ts) | Reconciliação de saldo e ledger em snapshot único                     |
| [Persistência por domínio](src/domains)                                | Registros, repositórios e schemas de wallet, wagering, inbox e outbox |
| [TransactionRepositories](src/shared/transaction-repositories.ts)      | Composição dos repositórios na mesma tentativa transacional           |
| [Infraestrutura de banco](src/core/database)                           | Conexões, prazos, TransactionRecordStore e migrations                 |
| [Mensageria](src/domains/messaging)                                    | Consumidor de comandos, publisher e eventos de integração             |
| [Testes](tests) e [campanhas](scripts)                                 | Contratos, concorrência real e recuperação                            |

Autenticação externa, partidas dobradas, tracing e dashboards não foram implementados. Os limites estão descritos em [ARCHITECTURE.md](ARCHITECTURE.md).
