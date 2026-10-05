# Testes de carga: cenários e resultados

Os testes verificam apostas distribuídas, duplicatas, falha do broker e 100 operações disputando a mesma wallet. O objetivo é observar progresso, correção financeira e recuperação.

## Ambiente

Execução local do `bun run test:load` em um projeto Docker isolado: três réplicas atrás do Nginx, PostgreSQL e LocalStack.

Cada cenário recebeu wallets novas com `100.00 BRL`. Usamos até 10 requisições simultâneas, exceto no pico de 100.

## Cenários

1. **Wallets independentes:** envio de 200 BETs de `1.00 BRL` entre 20 wallets. Todas foram processadas, as três réplicas receberam apostas e cada saldo terminou em `90.00 BRL`. Foram publicados os 400 eventos esperados.

2. **Disputa com duplicatas:** envio de 20 apostas distintas de `10.00 BRL` para uma wallet, cada uma duas vezes. Dez foram processadas e dez rejeitadas por saldo insuficiente. A repetição das 20 identidades manteve os resultados registrados no banco, sem novos débitos. O saldo final foi `0.00 BRL`, a versão foi `11` e foram publicados 30 eventos.

3. **Falha do broker:** envio de 100 BETs de `1.00 BRL` entre dez wallets durante a indisponibilidade do broker. Todas foram confirmadas no banco antes do reinício. Após a recuperação, foram recebidos os 200 eventos distintos esperados. O atraso de publicação inclui o tempo de reinício e recuperação, não apenas os 10 segundos de parada.

4. **Pico em uma wallet:** envio de 100 BETs simultâneos, com identidades distintas e valor de `1.00 BRL`. Sem novas tentativas na primeira onda, 11 foram processadas e 89 retornaram HTTP 503; o p95 foi 3249.85 ms. A recuperação das 89 restantes usou as mesmas identidades e concorrência 10: foram necessárias 290 tentativas, das quais 201 retornaram 503, com p95 de 713.03 ms. Ao final, as 100 operações estavam processadas, com saldo `0.00 BRL`, versão `101`, 101 entradas reconciliadas, incluindo a abertura, e 200 eventos publicados.

## Medições

| Cenário               | Operações/s |       p50 / p95 / p99 (ms) | Erro HTTP | Conflitos | Outbox médio / máximo (s) |
| --------------------- | ----------: | -------------------------: | --------: | --------: | ------------------------: |
| Wallets independentes |       19.99 |   476.36 / 769.97 / 930.24 |     0.00% |         0 |               1.41 / 2.60 |
| Duplicatas            |        9.19 |   186.73 / 665.32 / 769.81 |    15.49% |        52 |               0.27 / 0.45 |
| Falha do broker       |       26.41 |   365.65 / 531.24 / 595.69 |     0.00% |         7 |             23.62 / 24.65 |
| Pico em uma wallet    |        5.57 | 481.88 / 3120.35 / 3253.72 |    74.36% |       853 |               0.36 / 1.48 |

| Cenário               | Tentativas HTTP | Novas tentativas | Replays | Timeouts de lock | Eventos publicados / pendentes |
| --------------------- | --------------: | ---------------: | ------: | ---------------: | -----------------------------: |
| Wallets independentes |             200 |                0 |       0 |                0 |                        400 / 0 |
| Duplicatas            |              71 |               11 |      20 |                0 |                         30 / 0 |
| Falha do broker       |             100 |                0 |       0 |                0 |                        200 / 0 |
| Pico em uma wallet    |             390 |              290 |       0 |                5 |                        200 / 0 |

Operações/s considera operações únicas e o tempo das requisições HTTP, não a duração completa do cenário com espera por eventos e reconciliação. As latências e os erros HTTP consideram as tentativas; o pico agrega a primeira onda e a recuperação. Os conflitos são falhas de atualização concorrente, somadas nas três réplicas. O atraso da outbox é o tempo entre a ocorrência do evento e sua publicação, não até o recebimento pelo consumidor.

## Leitura

Os quatro cenários passaram na reconciliação financeira, sem operações incertas, timeouts de requisição ou eventos pendentes ao final. Houve cinco timeouts de lock no pico, recuperados pelas tentativas seguintes. Isso não apaga os erros HTTP: a contenção exigiu muitas novas tentativas, mesmo com a concorrência reduzida. Não houve conflitos de serialização nem deadlocks.

A execução mostra progresso entre wallets, proteção contra débitos duplicados e recuperação do broker e de respostas transitórias. Também expõe o custo da contenção em uma wallet.

Os resultados mostram que o sistema mantém a invariante mais relevante definida inicialmente: consistência financeira, mesmo a custa de possíveis perdas em desempenho. Diferentes técnicas para definir limites de operação e otimizar cenários específicos poderiam ser utilizadas, como o uso de bibliotecas como k6 ou o uso de batching das operações, mas o resultado obtido é suficiente para ser considerado um baseline de implementação.
