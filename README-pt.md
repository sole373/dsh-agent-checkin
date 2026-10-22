# dsh-agent-checkin

> Registro diário agregado e conexão de modelos para o DeepSeek Harness — um plugin, três tarefas.

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

## What it does

Este plugin conecta os clientes de IA que você já tem instalados ao DeepSeek Harness (DSH) de três maneiras:

1. **Registro agregado** — executa uma rodada de registro em todas as plataformas suportadas e
   depois informa o resultado de cada plataforma *e* seu saldo de créditos em tempo real em um só
   lugar.
2. **Clientes locais como provedores de modelos** — lê o catálogo de modelos dos clientes de IA já
   conectados nesta máquina (TRAE, Qoder CN, WorkBuddy, Baidu DuMate, WPS Lingxi) e os registra
   como provedores, para que seus modelos apareçam no seletor e possam ser usados no chat.
3. **Conexão de modelos** — pega um endpoint compatível com OpenAI ou com Anthropic e o registra
   como rota de provedor dentro do DSH.

As três partes leem o mesmo conjunto de clientes locais. Os saldos do painel e os modelos do
seletor pertencem às mesmas contas.

O **painel de uso de tokens** é uma quarta interface, independente: ele lê os logs de sessão do
próprio DSH, informa quanto token cada provedor / modelo consumiu e, na parte de baixo, traz o
**ranking autorizado de modelos e as recomendações por tarefa** (as pontuações de capacidade vêm
de um ranking público; «quais modelos existem» vem só desta máquina). Ele não tem relação com as
três tarefas acima — veja «[Painel de uso de tokens](#painel-de-uso-de-tokens)».

> **Estado de conclusão (2026-10-19, v0.8.0).** ① O registro agregado está **pronto e
> funcionando**. ② A conexão de modelos a partir de clientes locais está **corrigida e ampliada
> para cinco plataformas**: TRAE (CN/global), Qoder CN, WorkBuddy (CN/global), Baidu DuMate e WPS
> Lingxi compartilham a arquitetura de cinco camadas de `lib/connect/` (credenciais locais →
> catálogo de modelos → shim de loopback → PiAiAdapter → registro); escolha as plataformas e os
> modelos de cada uma em **Configurações → Registro agregado → Plataformas e modelos**, e a
> alteração passa a valer ao salvar, sem reiniciar. ③ O **painel de uso de tokens está pronto** —
> uma entrada «Uso de tokens» na barra lateral que lê os logs de sessão do próprio DSH e detalha,
> por provedor / modelo, os quatro segmentos de token, o número de chamadas e a taxa de acerto de
> cache (com tendência, distribuição por origem, ranking e tabela detalhada), além de um emblema
> de saldo de créditos do provedor atual à esquerda do campo de entrada; no fim desse mesmo painel
> há ainda o **ranking autorizado de modelos com recomendações por tipo de tarefa** (as pontuações
> de capacidade vêm do ranking público Artificial Analysis / OpenRouter, e «quais modelos existem»
> vem apenas do catálogo local e das suas marcações — **aparecer no ranking não significa que você
> tem assinatura**). ④ A metade `modelRoutes` funciona, mas só
> aceita `apiKeyEnv` estático e não tem suporte a `headers`; o perfil atual não declara nenhuma rota.
>
> **O PhanthyWork não é suportado de forma alguma (medido, removido na 1.1.0).** Sua porta de proxy
> reverso 3456 nunca escuta, as credenciais reais vivem apenas na memória do processo principal, e o
> estado de check-in só era legível por uma chave leveldb escrita pelo app — não havia rota de modelo
> nem resgate verificável. A plataforma foi removida: sem modelos e sem check-in.
>
> **DuMate e QwenWork: só modelos, sem check-in.** Ambas foram retiradas do check-in na 1.1.0 porque a
> concessão diária é disparada por *abrir o cliente*, e o estado de login só é conhecível por rastros
> escritos pelo cliente — o plugin teria de falsificar um login ou adivinhar, e as duas coisas violam
> a disciplina de honestidade. Abra o cliente você mesmo para receber. **As rotas de modelo não foram
> afetadas e continuam disponíveis** (`dumate`, `qwenwork-cn`).

## Requirements

- DSH `0.2.x`.
- Python 3.9+ no `PATH` (apenas para a parte de registro).
- Node 22.19+ ou 24+ com o módulo embutido `node:sqlite` (apenas para `traeProvider`).
- O motor já vem **incluído** neste pacote, em `engine/` — nada mais a instalar. Se você mantém a
  sua própria cópia do motor, aponte `homeDir` para ela.

## Installation

```bash
dsh plugin install ./dsh-agent-checkin
```

Ou adicione manualmente a um perfil:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- insert:
    - id: dsh-agent-checkin
      name: dsh-agent-checkin
```

## Usage

### Registrar

| Superfície | Como |
| --- | --- |
| Comando | `/checkin` — uma rodada em todas as plataformas |
| Comando | `/checkin trae,lingxi` — apenas as plataformas listadas |
| Comando | `/checkin --force` — ignora a idempotência do dia e resgata de novo |
| Comando | `/checkin-status` — mostra a rodada anterior sem executá-la de novo |
| Ferramenta | `checkin_run` — o mesmo, invocável pelo agente |
| Painel de ajustes | o botão «Fazer check-in agora» — um clique lança uma rodada e mostra os resultados por plataforma |
| HTTP | `GET /dsh-agent-checkin/status` — instantâneo JSON para um painel |
| Navegador | `GET /dsh-agent-checkin` — painel legível por pessoas |

**Nada é resgatado por padrão.** O plugin vem com `allowClaim: false`, o que força cada rodada ao
modo somente leitura. Um registro que realmente altera o saldo de uma conta é uma ação no mundo
real, portanto precisa ser ativado deliberadamente:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    allowClaim: true
```

Também é possível alternar pelo **painel de configurações de plugins** do host: `allowClaim`,
`pythonCommand`, `homeDir`, `timeoutMs` e `pushResult` têm recarga a quente, então a alteração vale
na próxima rodada sem reiniciar o host.

O interruptor de resgate desse painel está mesmo ligado: ele grava o novo valor no
`cordis.patch.yml` do seu perfil pelo serviço `configEditor` do host (bloqueio de arquivo,
validação, escrita atômica, reversão em caso de falha), e o hot-commit volatile faz a instância em
execução ler o valor na hora. Um clique basta: nem editar YAML à mão, nem reiniciar. Se a escrita
falhar, o painel mostra o motivo real do servidor em vez de um falso sucesso; e se o valor já era o
pedido, ele diz isso em vez de fingir que gravou algo.

### O painel

Abra `http://127.0.0.1:<porta>/dsh-agent-checkin` em um navegador na mesma máquina. Ele é servido apenas
na interface de loopback: qualquer requisição cujo `Host` ou `Origin` não seja um endereço de
loopback recebe 403, de modo que outro aplicativo local (ou uma página alcançada por DNS
rebinding) não consiga ler seus saldos.

A página segue as mesmas regras de honestidade da saída por comando:

- **O modo somente leitura aparece no topo.** Com `allowClaim: false` o cabeçalho diz que a rodada
  não resgatou nada.
- **Plataformas somente leitura ficam em uma seção própria.** Plataformas sem endpoint de resgate
  nunca contam como «registro bem-sucedido», porque essa ação não existiu.
- **Não há total entre plataformas.** Pontos, créditos e 灵感值 são moedas diferentes; somá-los
  produz um número sem significado. A página diz isso em vez de mostrar um.
- **Saldo desconhecido aparece como `—`, não como `0`.** Zero é uma leitura; «não foi possível ler»
  não é.
- **O que foi lido é mostrado.** Cada plataforma guarda o saldo disponível em um campo diferente
  (TRAE e WorkBuddy CN em `total_credits`). A normalização fica no
  `bridge.py` do motor; o plugin a repete por segurança, então os saldos continuam aparecendo mesmo
  que você aponte `homeDir` para sua própria cópia do motor sem esse patch.
- **Cada número é rotulado pela origem** — lido nesta rodada, carregado do arquivo de estado, ou
  ausente.
- **Os riscos de cada plataforma aparecem na página.** Avisos sobre impressão digital de
  dispositivo ficam no rodapé em vez de só nos comentários do código.

O endpoint JSON `/dsh-agent-checkin/status` devolve os mesmos dados para scripts.

### Painel de uso de tokens

Logo abaixo da barra lateral de configurações, depois das seções integradas, há outra entrada: **Uso de tokens**. Ela não fica no painel de configurações, e sim num painel principal independente — basta clicar no ícone da barra lateral para abri-lo.

O painel mede o consumo de modelos de **todos os workspaces e todas as sessões desta máquina**, e a fonte de dados são os logs de sessão que o próprio DSH escreve (`$DSH_HOME/sessions/`), não os resultados de registro deste plugin; portanto ele é totalmente independente da metade de registro: você pode consultá-lo sem fazer check-in, e uma falha de check-in não o afeta.

- **Sete cartões de estatística**: consumo acumulado, hoje, últimos 7 dias e número de chamadas, mais acertos de cache, erros de cache e taxa de acerto de cache. O subtítulo do cartão de chamadas ainda informa «quantas origens · quantos modelos» — **o número de origens não é o número de modelos**; sob um provedor costumam existir dezenas de modelos, e reportar esses dois números separadamente evita que «11 origens conectadas» seja lido como «apenas 11 modelos».
- **O critério dos três indicadores de cache** (escrito nas dicas dos cartões e também aqui): **acerto = `cacheRead`**; **erro = `input + cacheWrite`**; **taxa de acerto = acerto ÷ (input + acerto + escrita)**. O denominador **não inclui a saída** — tokens de saída nunca são candidatos a cache, e contá-los deixaria a taxa artificialmente bonita. Quando o denominador é 0, aparece «—» e **não 0%**: 0% é uma leitura, «não há denominador para calcular» não é. Esses três indicadores usam a mesma base do «consumo acumulado» (todo o período) e não mudam com a janela de tempo — calculá-los por janela exigiria que o backend também dividisse os baldes diários em quatro segmentos, o que é outra tarefa.
- **Janela de tempo comutável**: 7 dias / 30 dias / 90 dias / tudo. Trocar só muda o intervalo exibido, sem reescanear — o scanner classifica todo o histórico de uma vez, e a janela é recortada sobre o resultado.
- **Três gráficos lado a lado numa só linha**: tendência de consumo (alternável entre «diário» e «acumulado»), distribuição por origem (gráfico de anel, com as 6 primeiras origens) e ranking de uso de modelos (os 8 primeiros modelos). A largura do gráfico de tendência é dimensionada para um terço da coluna (espaço de coordenadas de 360, não os 640 da versão anterior — com 640, num terço de coluna, as marcações da direita ficam espremidas até não dar para ver).
- **Tabela detalhada por origem**: lista linha a linha os quatro segmentos de uso e o número de chamadas de cada combinação provedor / modelo, além de três colunas de eficiência calculadas na hora a partir dos mesmos dados — **taxa de acerto**, **consumo médio por chamada** (total ÷ número de chamadas) e **proporção de saída** (saída ÷ total). As duas últimas servem para distinguir «caro, mas resolve de uma vez» de «barato, mas vai e volta».
- **O rodapé relata o custo da varredura com honestidade**: quantos arquivos de sessão foram varridos, quantos MB, quantos foram reescaneados nesta rodada, quantas mensagens faturáveis e quantos milissegundos levou. **Quando a rodada não termina por tempo esgotado, ele escreve «não terminou por tempo esgotado nesta rodada»**, e não veste meia base de dados como resultado completo.

O endpoint HTTP `GET /dsh-agent-checkin/usage` devolve os mesmos dados para scripts:

| Parâmetro | Significado |
| --- | --- |
| `days=7` | Janela de tempo (dias). Omitido, usa a janela padrão; `3650` significa «tudo» |
| `refresh=1` | Ignora o cache em memória e reescaneia à força |

O endpoint usa a mesma guarda do resto das rotas do plugin: só aceita requisições de loopback local (não loopback recebe 403), só aceita `GET` / `HEAD`, e a resposta é sempre `cache-control: no-store` — «acabei de atualizar e os números continuam velhos» é o modo de falha que mais destrói a confiança num painel assim.

#### Como os números são calculados

Vale explicitar este bloco, porque ele já tropeçou em quatro armadilhas que **calculam errado em silêncio**:

- **Um log de sessão é «zstd multiframe», não um único quadro.** Medido, um `session.v4.jsonl.zstd` contém **12829 quadros** zstd independentes emendados um no outro; chamar `zstdDecompressSync` diretamente descomprime só o primeiro quadro, e **os 99% restantes são descartados em silêncio**, sem erro nenhum. Por isso o scanner fatia quadro a quadro (achando as fronteiras pela assinatura zstd `0xfd2fb528`) e depois descomprime cada um.
- **O uso de `assistant/attempt` é duplicado.** A mesma chamada registra o usage duas vezes, em `attempt` e em `message` (o de `attempt` só aparece em `data.stream[].chunk.usage`, e é a mesma coisa que o `data.usage` final); contar os dois dobraria o total do nada. O scanner **só reconhece `assistant/message`**; `attempt` serve para deduplicação e correlação, e não entra na contagem.
- **O campo `totalTokens` é um critério antigo.** Ele é sempre igual a `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` (conferido com 8129 registros, 7952 batem exatamente e os 177 restantes são registros de versões antigas sem `cacheWriteTokens`), enquanto a verdadeira «entrada faturável» é `input + cacheRead + cacheWrite`. Por isso o total mostrado na página é sempre **somado a partir dos quatro segmentos**, sem ler aquele campo pronto — não dá para contar que ele esteja sempre atualizado.
- **Quando o mesmo nome de sessão existe em várias versões, só a versão mais alta é lida** (`session.v4.jsonl` e `session.jsonl` coexistem); caso contrário, o mesmo uso seria contado duas vezes.

#### Cache incremental

Os logs só crescem, nunca encolhem, então a estratégia de cache é «instantâneo em memória + invalidação por arquivo»: guarda-se o `size:mtime` de cada arquivo de sessão e, na próxima vez, só os que mudaram são reescaneados. Medido num cenário de 44 arquivos e 9333 mensagens faturáveis, a varredura fria leva cerca de 1,5 segundo e a quente cerca de 150 milissegundos.

O TTL do cache é controlado pela opção de configuração `usageCacheSeconds` (padrão 30 segundos). O botão «atualizar» do painel sempre ignora o cache e reescaneia; esse valor só afeta a consulta automática e outros chamadores. **Nada de banco de dados**: 43 logs / 48 MB levam 1,3 segundo numa varredura fria, e como os logs só crescem, o cache em memória já reduz a atualização diária a poucos milissegundos; introduzir SQLite só acrescentaria uma cópia a migrar e a conciliar com os logs.

#### Emblema de saldo no campo de entrada

À esquerda do campo de entrada (`conversation.input.left`) também aparece o **saldo de créditos do provedor usado pelo agente atualmente referenciado**. O que mais importa aqui é **não mentir**:

- **Só renderiza quando a plataforma realmente tem o conceito de «saldo de créditos»** (como o WorkBuddy). Plataformas de cobrança por token pós-pago não têm nada disso, e inventar um número seria mentir — nesse caso **o emblema inteiro não é renderizado**, e **nenhuma consulta periódica é iniciada**.
- **Saldo desconhecido simplesmente não aparece**, em vez de mostrar `0`. Zero é uma leitura; «não foi possível ler» não é.
- **Passar o mouse mostra a origem**: se o número é «medido» ou «digitado à mão» fica escrito no `title`, e os dois nunca se confundem.
- **A consulta periódica é bem espaçada**: o saldo muda por dia, então uma vez por minuto já é muito mais do que o necessário.
- **Convivência com o `dsh-connect-workbuddy`**: o plugin antigo também ocupa esse slot (order 4, e só renderiza para o provedor dele); este plugin vem logo depois com order 5, e os dois se distinguem por «só reconhecer os provedores que cada um conhece», de modo que nunca surgem dois emblemas ao mesmo tempo.

#### Fronteira de erro do painel

O painel de uso tem uma fronteira de erro do React por fora (componente de classe — `getDerivedStateFromError` é exclusivo de classes, e componentes de função não têm equivalente). **Por que ela é obrigatória**: se um componente do slot `main` lançar uma exceção durante a renderização, o host renderiza o painel inteiro em branco ou recua para um fallback, e **aquela linha de erro no console do navegador o usuário não vê** (a versão desktop não tem entrada para devtools); o sintoma é «cliquei no botão da barra lateral e não aconteceu nada». Com essa fronteira, a mesma falha vira uma linha vermelha na página, e o usuário pode ler o motivo diretamente para quem mantém o plugin.

A seção de ranking tem, **além disso**, uma fronteira própria: não conseguir buscar o ranking não deve deixar em branco as estatísticas de uso acima dela, porque as duas coisas falham por motivos totalmente alheios uma à outra.

#### O ranking autorizado de modelos e as recomendações por tarefa

No fim do painel há ainda um bloco: o **ranking autorizado de modelos**, além de recomendações por tipo de tarefa. Ele é montado a partir de duas metades cujas origens ficam estritamente separadas:

- **As pontuações de capacidade vêm de um ranking público** — os índices de inteligência / programação / agêntico da Artificial Analysis, obtidos pela API pública do OpenRouter (`https://openrouter.ai/api/v1/models`, sem autenticação). **Este plugin não estima pontuação nenhuma**: o catálogo local do cliente traz apenas id, nome, multiplicador e se aceita imagens, **nenhuma dimensão de qualidade** — adivinhar força pelo nome seria inventar.
- **«Quais modelos existem» vem só desta máquina** — lista apenas os modelos que existem de fato no catálogo do cliente local (na região em que você está conectado) e já com as suas seleções em «Plataformas e modelos» aplicadas. Modelos que o ranking tem mas o catálogo local não têm ficam de fora: a classificação serve para «o que eu posso usar agora», não para «o que existe no mundo».

**Uma coisa que precisa ficar clara**: o catálogo do cliente é uma **lista de produtos e não é filtrada pela assinatura da conta**. Medido numa conta `workbuddy-global` sem assinatura, o catálogo continua trazendo `gpt-6-astra` / `gpt-5.4` e os demais modelos da família GPT. Portanto **um modelo aparecer no ranking não significa que a sua conta tenha direito de chamá-lo** — essa frase está impressa no painel como é, sem fingir que a classificação equivale a direito de assinatura. O painel também não tem como determinar a assinatura sozinho: nenhum catálogo de plataforma traz **campo algum de direitos** (um grep por `vip|subscrib|entitle|tier|quota` no catálogo do WorkBuddy só encontra uma menção a «modelo gratuito» num comentário). Quando o modelo realmente não pode ser chamado, o erro da própria plataforma aparece como sempre — esse é o sinal autoritativo.

O que o painel mostra:

- **Ranking geral**: por índice de inteligência decrescente, no máximo 12 linhas, cada uma informando as plataformas por onde o modelo está disponível, os índices de inteligência / programação / agêntico, a janela de contexto, o preço por milhão de tokens de entrada e o multiplicador dado pelo cliente (o multiplicador aparece com o prefixo `x`, para não ser confundido com parte da pontuação).
- **Recomendações por tipo de tarefa**, seis categorias: escrever código, raciocínio e matemática, agêntico e uso de ferramentas, documentos longos, multimodal (ver imagens) e rápido e econômico. **Cada cartão escreve a sua própria regra de ordenação no cartão**, para que «por que este está em primeiro» possa ser reconferido na hora:
  - escrever código → por índice de programação decrescente, com o índice de inteligência como reserva para quem não tem índice de programação;
  - raciocínio e matemática → por índice de inteligência decrescente;
  - agêntico e uso de ferramentas → por índice agêntico decrescente, com o índice de inteligência como reserva para quem não tem;
  - documentos longos → por janela de contexto decrescente;
  - multimodal → apenas modelos que aceitam entrada de imagem, por índice de inteligência decrescente;
  - rápido e econômico → apenas modelos com índice de inteligência ≥ 40, por preço por milhão de tokens de entrada crescente.
    **Esse piso de 40 é de propósito**: um modelo barato abaixo dele não merece o nome de «econômico», é só fraco.

Duas convenções numéricas merecem ser explicadas à parte, porque são a mesma classe de erro vista pelo lado oposto:

- **«Não existe esse índice» e «esse índice é 0» são duas coisas diferentes.** O ranking manda um **`null` explícito** para o índice ausente (medido: o `coding_index` de `anthropic/claude-haiku-5.5` é `null`), e `Number(null)` é `0`. A redação anterior chamava `Number(value)` direto, e assim **98 modelos sem índice de programação foram tratados como «pontuação 0 em programação»**, ficando à frente de modelos realmente fracos no ranking de código. Agora o `null` continua `null` e a página mostra «—».
- **Um modelo sem índice de inteligência vai para o fim, e não é tratado como 0.** Ao ordenar o ranking geral, o `null` fica depois de todos os modelos que têm pontuação, em vez de se misturar à faixa baixa.

Uma falha no ranking **não** é fatal: se houver um ranking antigo em mãos, o painel continua usando-o e marca «esta atualização falhou; abaixo está o último ranking obtido com sucesso» junto com o motivo. Só «nunca deu certo nem uma vez» mostra falha — e mesmo aí é obrigatório explicar **por que não há classificação**, em vez de desenhar uma tabela vazia que sugira que esta máquina não tem modelos utilizáveis. Por outro lado, alcançar o ranking e não casar com nada não é erro, é fato, e o painel diz isso: «nenhum dos N modelos disponíveis nesta máquina casou com o ranking — pode ser que ele ainda não os liste», listando os nomes que não casaram, para você julgar se falta entrada no ranking ou se os nomes não batem.

O cache do ranking segue o mesmo esquema do scanner de uso: instantâneo em memória + fallback em disco (`$DSH_HOME/dsh-agent-checkin/model-rank.json`) + serialização de requisições concorrentes. O TTL é de 6 horas — o ranking muda na escala de dias, então atualizar com mais frequência só desperdiça rede.

O endpoint HTTP `GET /dsh-agent-checkin/model-rank` devolve os mesmos dados; `?refresh=1` força uma nova busca do ranking ignorando o cache. As guardas são as mesmas de `/usage` (só loopback, só `GET`/`HEAD`, `no-store`).

### O painel de configurações

**Configurações → Agent Check-in** — fica no fim da barra lateral de configurações, depois das seções
integradas — então o trabalho do dia a dia não exige a linha de comando:

- **Fazer check-in agora** dispara uma rodada completa pelo painel (equivale a `/checkin` numa
  conversa), sem linha de comando.
  - O botão responde "iniciado" na hora; **`started` significa apenas que a rodada foi aceita, não
    que deu certo.** Quando a rodada termina, uma tabela por plataforma aparece sob os botões, e essa
    tabela é o único veredito (`ALREADY` / já resgatado hoje aparece como é).
  - É a **única ação do painel que realmente muda saldos**: o texto do botão e o subtítulo dizem com
    clareza se a rodada resgata ou apenas verifica (decidido por `allowClaim`). Enquanto roda, os
    botões ficam desativados e mostram "em execução"; cliques repetidos nunca iniciam uma segunda
    rodada.
  - "Forçar repetição" ignora a proteção de "já resgatado hoje", e se isso duplica o resgate é cada
    plataforma que decide — o painel avisa ao lado do botão. Um clique normal nunca faz isso.
  - Se o motor não arranca, o painel mostra o motivo (nunca relata "sem resultado" como "sem
    falha"); se a rodada não traz detalhe por plataforma, isso é dito, em vez de renderizar uma
    tabela vazia como se nada faltasse.
- **Verificar login (somente leitura)** chama de verdade um endpoint somente leitura de cada
  plataforma e reporta um de três estados — OK / não configurado / falhou. **Não resgata nada**, e não
  começa a resgatar só porque `allowClaim` está ligado.
- **Login em um clique** dá a quatro plataformas um botão *Abrir janela de login*, em duas formas:
  - **Baseadas em cookie (WPS Lingxi, 即梦)**: abre uma janela de navegador separada nesta máquina;
    você faz login normalmente e o plugin recolhe o cookie, verifica uma vez e só então grava em
    disco. Sem F12, sem copiar cabeçalhos, sem parâmetros de linha de comando.
  - **Baseadas em perfil (Kling)**: essa plataforma entrega o benefício diário por *uma
    visita com a sessão iniciada*, e a credencial é um perfil de navegador inteiro, não um cookie
    solto. O botão também abre a própria janela; depois do login você fecha essa janela você mesmo, e
    só então o plugin roda uma verificação somente leitura da sessão — passar nela é o que conta como
    sessão válida.
  - O controle é um **botão comum que faz POST** a um endpoint local: nada navega, então a página de
    configurações e o resto do harness ficam exatamente onde estão. Vale explicitar porque dois
    desenhos anteriores falharam justamente aqui: um link que abria na mesma aba
    (`target: '_self'`) derrubava toda a interface do host, e um que abria nova aba
    (`target: '_blank'`) não produzia janela nenhuma neste shell Electron.
  - Os pedidos do painel **não levam `Origin`**, o que é normal neste host (o próprio guarda do DSH
    aceita a ausência de `Origin`). Por isso a verificação de escrita é: se houver `Origin`, ele deve
    ser de mesma origem e apontar para esta porta de loopback; se não houver, só são recusados os
    pedidos digitados na barra de endereços (`Sec-Fetch-Site: none`). Todo o resto vindo de um socket
    de loopback é aceito — quem consegue forjar isso já está executando código nesta máquina e
    poderia ler o arquivo de credenciais diretamente.
  - **`started: true` significa apenas que a janela de coleta abriu.** Não é um login bem-sucedido. O
    painel consulta o endpoint de estado a cada 2 s e decide pelo resultado da coleta, nunca pelo
    fato de o botão ter respondido.
  - A janela usa um **perfil descartável**, então não enxerga a sua sessão normal do navegador. Isso é
    de propósito: senão «capturado» poderia significar apenas um cookie emprestado de outro navegador.
  - A coleta espera em segundo plano; o painel consulta a cada 2 s e um tempo esgotado (5 minutos por
    padrão) é reportado como tempo esgotado. Tempo esgotado **nunca** é registrado como sucesso, e nem
    um código de saída 0 sem uma marca explícita de sucesso. *Cancelar* só interrompe a espera e diz
    claramente que o login não terminou.
  - Quando a janela não abre, o motivo vem do próprio servidor e aparece abaixo do botão. Essa falha
    conta apenas como «o pedido não passou»; nunca é registrada como um login que falhou.
- **Credenciais manuais (reserva)** continuam para as duas plataformas baseadas em cookie, para
  ambientes onde a janela automática não abre. Ao salvar, roda na hora uma verificação somente leitura
  e o resultado aparece abaixo do campo — **«salvo» não é «consegue fazer check-in»**, e os dois são
  mostrados separadamente. O campo é limpo assim que o salvamento dá certo, para o segredo não ficar
  na página. As duas plataformas baseadas em perfil não têm campo para colar: a credencial delas não é
  um cookie, e colar um não serviria de nada.
- **As outras quatro plataformas não têm nem botão de login nem campo de entrada**, cada uma com o
  motivo em uma linha (a credencial fica cifrada dentro do cliente, ou não existe endpoint algum para
  resgatar). A entrada não existe porque não ajudaria, não porque foi esquecida.
- **Saldo atual por plataforma: primeiro o medido, com registro manual como reserva.** O saldo que cada
  plataforma mostra agora é listado: o valor que o motor realmente leu na última ronda vem marcado
  «medido» (indicando o campo da resposta de onde veio); plataformas sem endpoint de saldo permitem
  anotar um valor à mão, marcado «manual» com nota opcional. Um valor manual é a sua própria anotação,
  **não é uma recarga**, e nunca se passa por medido — a próxima medição real vence automaticamente.
- **Os saldos são listados por plataforma sem total**, igual ao painel e à saída dos comandos: cada
  plataforma usa uma moeda diferente e somá-las não significaria nada.
- **O interruptor de resgate realmente funciona.** Ao clicá-lo, o novo valor é gravado no
  `cordis.patch.yml` do seu perfil pelo serviço `configEditor` do host (bloqueio de arquivo,
  validação, escrita atômica, reversão em caso de falha) e o hot-commit volatile faz a instância em
  execução lê-lo na hora: sem editar YAML à mão e sem reiniciar. Se a escrita falhar, o painel mostra o
  motivo real do servidor em vez de fingir que deu certo; se o valor já era o pedido, ele diz claramente
  que nada foi gravado.
- **Aba «Plataformas e modelos»: escolha plataformas e modelos aqui mesmo.** Cada provedor conectado
  tem o seu cartão: ative «mostrar esta plataforma no seletor de modelos» e depois escolha **todos os
  modelos (seguir o catálogo do cliente)** — modelos que o cliente adicionar depois aparecem sozinhos —
  ou **escolho eu**, que começa vazio e guarda um subconjunto explícito. Os botões «tudo / nada /
  inverter» fazem «só três» ser um clique e mais três, não tudo e depois desmarcar um a um.
- **A taxa depois de cada modelo é o multiplicador do próprio cliente** — `creditMultiplier` do
  WorkBuddy, `priceFactor` do Qoder (`0` aparece como *grátis*), `features.consumption_rate.data.rate`
  do TRAE (preço promocional primeiro). Quando o cliente não publica nenhum, a coluna fica **vazia**;
  a página nunca mostra um número adivinhado.
- **A entrada de imagem é por modelo e não depende de quais modelos aparecem.** Cada cartão tem um
  bloco separado com três estados: **seguir a capacidade nativa** (o padrão — o que o catálogo disser
  que aceita imagens, e modelos multimodais que o cliente adicionar depois funcionarão sozinhos),
  **escolho eu** (uma lista explícita) ou um clique para desligar ou ligar todas. Um modelo exibido mas
  sem a marca de imagem continua aparecendo no seletor, só não pode receber imagens; ao contrário, um
  modelo que o catálogo não declara pode ser marcado à mão — **se a origem aceita mesmo isso se
  comprova medindo, e o plugin não decide isso pela origem.** O interruptor de plataforma, a lista
  branca de modelos e a lista de imagens são três armazéns independentes: desligar uma plataforma não
  apaga as marcas de imagem.
- **Salvar aplica na hora.** O plugin grava o arquivo e emite `llm/adapters-updated`, então o seletor
  de modelos do host se redesenha no ato — **sem reiniciar o host**. A escolha vive em
  `~/.dsh/dsh-agent-checkin/model-selection.json` (só interruptores e ids de modelo, nunca uma
  credencial). O painel de navegador `/dsh-agent-checkin/models` é a entrada equivalente quando não há
  interface de ajustes; ambos leem e gravam esse mesmo arquivo.

Tudo isso exige que o processo host lance Python e leia arquivos, então acontece no host; a metade do
navegador só faz chamadas HTTP para subrotas de `/dsh-agent-checkin/settings`. A credencial nunca passa pelo
frontend nem chega a um log — um salvamento bem-sucedido responde só com nomes de campo, nunca com
valores. Os relatórios de progresso do login também não levam id de processo.


### Idempotência e persistência

Cada rodada bem-sucedida é gravada em `$DSH_HOME/dsh-agent-checkin/last-run.json`, e uma rodada não
resgata de novo uma plataforma que **já teve sucesso hoje** (dia natural local). Isso importa porque
os endpoints de resgate são requisições de rede reais: rodar `/checkin` duas vezes por acidente não
deve atingi-los duas vezes.

- A proteção é por plataforma **e por dia natural**, e só conta `OK` / `ALREADY` / `DONE` em
  plataformas que realmente têm ação de resgate.
- **Falhas nunca são lembradas** — uma plataforma que falhou pode ser tentada de novo na hora.
- **Simulações não ativam a proteção** — elas não resgatam nada, então não são prova de «já feito
  hoje».
- `/checkin --force` (ou `checkin_run` com `force: true`) a ignora; essa saída é deliberada e não
  silenciosa.
- Quando tudo já está feito, a rodada informa `source: skipped` e **não envia requisição alguma**.
  É um terceiro resultado, nem sucesso nem falha.
- O arquivo de estado guarda apenas uma lista branca de campos de apresentação. Cookies, tokens e
  JWTs nunca chegam ao disco.
- Se o arquivo de estado não puder ser lido ou for de um formato antigo, ele é ignorado em vez de
  confiado, e a rodada se comporta como a primeira.

### Check-in diário automático

| Comando | O que faz |
| --- | --- |
| `/checkin-schedule on 09:00` | ativa um lembrete diário nesta sessão (hora opcional, padrão 09:00) |
| `/checkin-schedule off` | desativa |
| `/checkin-schedule status` | mostra o estado e a hora realmente em vigor |

A tarefa fica no serviço Schedule do host e dispara **no relógio local da sua máquina**. Ao
disparar, a sessão atual recebe um lembrete pedindo ao agente que chame `checkin_run` e relate o
resultado.

O plugin só promete o que de fato consegue garantir:

- O host garante que o lembrete **entra na caixa de entrada da sessão** — não que o modelo seja
  despertado no instante exato. Se a sessão estiver ociosa, o lembrete é processado quando você
  abri-la de novo.
- Portanto o check-in acontece no caminho **o agente recebe o lembrete e chama a ferramenta**; o
  plugin não executa nada em segredo nos bastidores.
- Repetir `on` na mesma sessão não empilha tarefas duplicadas; `off` remove apenas a tarefa criada
  por este plugin e não mexe nos seus outros lembretes.
- Com `allowClaim: false` o horário também dispara, mas aquela rodada continua somente leitura — a
  saída do comando diz isso explicitamente.

Para mudar a hora, basta rodar `on HH:mm` de novo; isso substitui a tarefa anterior.

### Enviar resultados para a sessão

Com `pushResult: true` (padrão), `/checkin` injeta um resumo da rodada na sessão atual para
consulta posterior. Usa `agent.inject()`, não `followup()`: **a injeção não desperta uma sessão
ociosa** — o conteúdo aparece na próxima requisição daquela sessão. O resultado de um check-in é
algo que a sessão deve saber, mas pelo que não deve ser interrompida.

Se o envio falhar (sem sessão, recusa do host), apenas registra um aviso e nunca transforma o
resultado do check-in em falha: você está vendo o resultado real da rodada e ele não deve ser
reclassificado porque um envio secundário não chegou.

### O cliente precisa ficar aberto?

Se os modelos de uma plataforma funcionam depende de **de onde vem a credencial**, e não de o app
estar aberto. Três grupos:

| Plataforma | O cliente precisa ficar em execução? | Por quê |
| --- | --- | --- |
| **DuMate (Baidu)** | **Sim — precisa ficar em execução** (com sessão ou não) | O gateway de modelos dele é **local**: um `dumate-main-server` numa porta aleatória, e tanto a porta quanto `X-Dumate-Inapp-Key` mudam a cada inicialização. Se você fechar o cliente, os modelos somem. **É a única plataforma que realmente exige isso.** |
| **WPS Lingxi** | **Não** (mas o cookie precisa estar fresco) | A API de modelos fica **na nuvem** (`lingxi.wps.cn`): cria-se uma sessão com `POST /api/aioffice/v1/sessions` e a inferência roda por `wss://…/completions/ws`. Nenhuma porta local entra no caminho. O cliente é apenas a **origem do estado de login**: o cookie é coletado dele e depois o cliente pode ser fechado. O cookie **expira em três dias** (`exp=259200`), então de vez em quando é preciso reabrir o cliente para coletá-lo de novo. |
| **WorkBuddy CN / global** | **Não, mas o cliente precisa estar instalado** | A API de modelos também está na nuvem (`copilot.tencent.com` / `www.codebuddy.ai`). Mas desde a 5.6.x o cliente cifra seus campos de login (`$wbEncrypted`), e a chave de descriptografia é entregue pelo **binário de desktop** via `ELECTRON_RUN_AS_NODE` — então `WorkBuddy.exe` precisa estar presente e ser **executável** nesta máquina (instalado basta; não precisa estar rodando). |
| **TRAE CN / global** | Não | Credencial e catálogo são **arquivos estáticos** (`storage.json` + `state.vscdb`), lidos uma vez. |
| **Qoder CN** | Não | A credencial fica no armazenamento OSCrypt do Chromium e é descriptografada em memória via o DPAPI do sistema, sem relação com o processo do cliente. |

Em uma frase: **só o DuMate exige o cliente em execução; o Lingxi precisa de cookie fresco (não de
cliente aberto); o WorkBuddy precisa do cliente instalado (não aberto).**

> **Onde fica o cookie do Lingxi**: `<dshHome>/dsh-agent-checkin/engine/lx_cookie.txt` (recomendado:
> reinstalar o plugin não apaga mais ele). O plugin procura nesta ordem: a variável de ambiente
> `LINGXI_COOKIE_FILE` → esse caminho → o `engine/lx_cookie.txt` que vem no pacote. Só quando as
> três falham a plataforma conta como «não conectada», e o cartão lista então todos os caminhos
> que ele testou.

### Usar o TRAE como provedor de modelos

Ative-o:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    traeProvider: true
```

Ao ser ativado, o plugin lê dois arquivos do cliente TRAE já conectado, **em modo somente leitura**:

| Arquivo | O que fornece |
| --- | --- |
| `%APPDATA%\TRAE CN\User\globalStorage\storage.json` | o token de sessão descriptografado, o id do dispositivo, o id do usuário, a região |
| `%APPDATA%\TRAE CN\User\globalStorage\state.vscdb` | o catálogo de modelos — a lista de modelos que a sua conta pode usar |

Nada é escrito de volta. As credenciais não são enviadas a nenhum lugar além do próprio domínio
de API do TRAE — o mesmo domínio com o qual o cliente conversa, obtido da credencial e não
fixo no código.

O provedor aparece então no seletor de modelos como **TRAE（本机客户端）**. Depois disso você pode
conversar com qualquer modelo do catálogo. O plugin envia a mesma requisição real que o próprio
cliente faz — `POST /api/agent/v3/llm_utils_chat` no gateway da sua região
(`https://trae-api-cn.mchost.guru` para o cliente CN), com a mesma autenticação `Cloud-IDE-JWT` e a
mesma identidade de dispositivo — portanto a cota da própria conta se aplica.

O plugin diz três coisas com toda a clareza:

- **A disponibilidade depende do `function` sob o qual o modelo está listado.** O endpoint de chat
  é `/api/agent/v3/llm_utils_chat`, e o corpo da requisição leva um `function` junto com `model`:
  **um modelo só existe sob alguns deles**. O plugin escolhe a partir do `appearedIn` do catálogo
  na ordem `solo_work_remote` → `solo_work_lite` → `solo_agent_remote` → `chat_v3` →
  `solo_coder`, e sempre cai em `solo_work_remote`; nunca repassa nomes de categoria que não sejam
  de chat, como `assistant` ou `solo_agent`.
- **Nem todo modelo é invocável: 30 dos 34 selecionáveis respondem, 4 são rejeitados na origem.**
  Em 2026-10-18 foi enviada uma requisição real mínima a cada um. `deepseek//deepseek-v4-flash`,
  `deepseek//deepseek-v4-pro` (variantes com `base_url` próprio), `kimi-k2.8-preview` e
  `qwen3.8-flash` devolveram `4001` sob todos os `function` candidatos, então são considerados
  indisponíveis na origem — o próprio cliente também não consegue invocar essas duas variantes. Um
  modelo que funciona pode funcionar sob um único `function`: `DeepSeek-V4-Flash-Official`
  responde em `solo_work_remote` / `solo_work_lite` / `solo_agent_remote`, devolve `1005` (o plano
  pago não cobre) em `chat_v3` e `4001` em `solo_coder`. O servidor pode mudar tudo isso, então o
  plugin não filtra antecipadamente.
- **A resposta é transmissão real, mas os quadros têm nome, não forma de OpenAI.** A origem envia
  `event: output` (`response` / `reasoning_content` / `tool_calls`), `event: token_usage` e
  `event: done`, além de quadros de contabilidade (`metadata` / `timing_cost` /
  `progress_notice`). O plugin converte `output` em chunks de OpenAI, normaliza `token_usage` em
  usage e traduz `done` em `finish_reason`; os quadros de contabilidade são descartados. Assim o
  texto aparece token a token, com os rastros internos ocultos.

> **Correção de uma afirmação anterior deste README.** Antes dizia «os 34 modelos responderam
> `HTTP 200`». Era falso: essas testes iam para `/api/ide/v2/llm_raw_chat`, um endpoint inferido
> que o cliente local nunca envia, e os 200 eram quadros de erro de requisições GET ou não JSON.
> Contra o endpoint real `llm_utils_chat` o resultado é o 30 / 4 acima.

Se o TRAE não estiver instalado, não houver sessão iniciada, ou os arquivos não puderem ser
lidos, o provedor simplesmente não se registra e o log diz por quê. Todo o resto do plugin
continua funcionando.

> **Estado da implementação (v0.6.0, 2026-10-17).** O antigo problema de «registro no DSH
> quebrado» está **corrigido**. A integração do TRAE foi refeita sobre a arquitetura comum de
> cinco camadas de `lib/connect/`: credenciais locais (somente leitura) → catálogo de modelos
> (state.vscdb, com atualização TTL) → shim de loopback (`127.0.0.1`, porta aleatória + bearer
> aleatório, traduzindo o protocolo agent-task para SSE OpenAI) → o PiAiAdapter do próprio host
> (streaming / uso / níveis de pensamento) → `registerAdapter` +
> `registerConfigurableProviders` (array de providers, settingsNs, declared:false, conforme o
> contrato do host). Os clientes CN e global são provedores separados, controlados por
> `traeProvider` / `traeIntlEnabled` respectivamente.

### Usar o Qoder CN como provedor de modelos

Ligue-o:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    qoderCnEnabled: true
```

O plugin lê o estado de login do cliente Qoder conectado (armazenado com OSCrypt do Chromium,
decifrado via DPAPI do sistema em memória; arquivos temporários são apagados na hora) e registra
o catálogo de modelos pelo mesmo shim de loopback como provedor **Qoder CN (cliente local)**.
Se o cliente não existir, não houver sessão ou a credencial não puder ser decifrada, o provedor
não se registra e o log explica por quê; todo o resto continua funcionando.

### Usar o WorkBuddy como provedor de modelos

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    wbProvider: true        # cliente CN
    wbProviderIntl: true    # cliente global (opcional)
```

> **Nota de conflito.** Esta função assume a conexão de modelos do plugin legado
> **dsh-connect-workbuddy**. Manter os dois ativos faz com que disputem o mesmo id de provedor.
> Desative primeiro o plugin legado: configurações do DSH → Plugins → dsh-connect-workbuddy →
> desativar, e reinicie o host; desinstale-o se desativar não bastar. Em caso de conflito de id,
> este plugin registra um aviso e pula o registro do WorkBuddy, sem afetar as demais plataformas
> nem o check-in.

O catálogo vem do `/v3/config` do cliente (separado por canal CN/global), e os ids de modelo são
**idênticos byte a byte** aos do plugin legado, então sessões e configurações existentes migram
diretamente. A renovação do token perto do vencimento acontece só na memória do processo: nada é
gravado em disco e nenhum arquivo do cliente é modificado.

### Conectar modelos

Declare uma rota na configuração:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    modelRoutes:
      - provider: my-gateway
        displayName: My Gateway
        api: openai-completions
        baseURL: https://gateway.example.com/v1
        apiKeyEnv: MY_GATEWAY_API_KEY
        models:
          - id: some-model
            name: Some Model
            contextWindow: 131072
            maxTokens: 8192
```

Depois aplique-a:

| Superfície | Como |
| --- | --- |
| Comando | `/checkin-models` — grava as rotas no perfil atual |
| Ferramenta | `model_route_apply` — o mesmo, com `dryRun: true` para visualizar antes |

`api` aceita `openai-completions`, `openai-responses` ou `anthropic-messages`. Uma rota construída
à mão **precisa** listar seus modelos explicitamente — o host não tem entrada de catálogo à qual
recorrer, e uma rota sem modelos é rejeitada de imediato.

A aplicação passa pelo serviço `configEditor` do host quando ele está disponível: esse caminho
preserva comentários YAML, grava de forma atômica, reverte em caso de falha e recarrega a
configuração. Quando `configEditor` está ausente, o plugin edita diretamente o patch do perfil, o
que exige reiniciar o DSH.

> **Limitação (ainda não implementada).** `modelRoutes` aceita **apenas credenciais estáticas**:
> `apiKeyEnv` é o *nome de uma variável de ambiente*, não um token que possa ser obtido do estado
> de login de um cliente desktop no momento da requisição. Qualquer upstream cuja credencial só
> exista dentro de outro app em tempo de execução não pode ser conectado assim. Também ainda não
> aceita `headers`: o `PiAiProviderProfile` do host tem esse campo, mas nem o schema `modelRoutes`
> deste plugin nem `toProviderProfile()` o expõem. Veja `模型接入路线-逐平台定案.md` §1 e §3.4.

## Honest reporting

O resumo de registro mantém deliberadamente quatro números separados:

- **success** conta `OK` / `ALREADY` / `DONE`
- **neutral** cobre `DRY_RUN` / `READONLY` / `INACTIVE`
- **blocked** cobre `SANDBOX_BLOCKED`
- **failure** cobre `AUTH_REJECTED` / `FORBIDDEN` / `NETWORK` / `ERROR` / `EXCEPTION`

`READONLY` significa «esta plataforma não tem nenhuma ação de resgate a executar». Não é um
sucesso, e fundi-lo na contagem de sucessos inflaria o numerador e disfarçaria de concluída uma
ação inexistente. O resumo informa `healthy` separadamente: plataformas que *têm* uma ação de
resgate real **e** tiveram sucesso.

`blocked` existe porque algumas falhas não têm nada a ver com a plataforma. Descriptografar as
credenciais guardadas exige um arquivo temporário, então os adaptadores chamam
`tempfile.mkdtemp()` e gravam ali uma chave. Sob um sandbox workspace-write o processo filho
consegue criar o diretório mas não consegue gravar dentro dele, e a descriptografia falha com
`PermissionError [Errno 13]`. Os adaptadores classificam isso como «credenciais indisponíveis», o
que levaria você a entrar novamente — e entrar novamente não resolve nada. O plugin reclassifica
como `SANDBOX_BLOCKED`, preserva o erro original para rastreabilidade e afirma claramente que é um
limite do ambiente, não um problema de credenciais. Apenas a combinação de um erro de permissão
negada **e** evidência apontando para o ambiente de execução (um caminho temporário, ou o próprio
sandbox se nomeando) dispara a reclassificação; um arquivo de credenciais realmente ilegível ou uma
sessão expirada continuam informando `failure`.

Os saldos nunca são somados entre plataformas. Créditos, pontos e valores de inspiração são moedas
diferentes; somá-los produz um número sem significado.

### Plataformas suportadas

`workbuddy`, `workbuddy_intl`, `trae`, `lingxi` têm uma ação
de resgate real (`claiming: true`). `jimeng` e `kling` são apenas sondas de estado em
somente leitura (`claiming: false`): informam o que a conta tem, mas o plugin nunca resgata por elas.

### Onde o motor escreve

O motor incluído vive dentro do pacote instalado. Dois adaptadores guardam ao lado dele os cookies
digitados à mão, e o adaptador de automação de navegador cria lá o seu perfil descartável
(`jimeng_cookie.txt`, `lx_cookie.txt`, `.<name>_profile/`). Pacotes instalados via npm costumam ser
somente leitura, então ou:

- aponte `homeDir` para uma cópia gravável do motor, **ou**
- deixe `jimeng_cookie.txt` / `lx_cookie.txt` prontos num lugar onde o motor possa escrever, e
  aceite que os adaptadores de automação de navegador (`jimeng`) venham a falhar em vez de funcionar
  pela metade em silêncio.

Tudo o que toca credenciais reais fica nesses arquivos; nada sai da sua máquina. A política dos
autores do motor está em `engine/SECURITY.md` e os riscos do registro automático em
`engine/DISCLAIMER.md`.

### O gateway local do DuMate e sua chave efêmera

O app de desktop do DuMate expõe um endpoint compatível com OpenAI numa porta local aleatória, mas
cada pedido precisa levar o cabeçalho `X-Dumate-Inapp-Key`: uma string hex aleatória de 32 bytes
gerada na inicialização do processo e injetada no renderer e nos processos filhos por variável de
ambiente. **Muda a cada reinício.**

O valor não está em nenhum arquivo de configuração, mas **é impresso nos logs do próprio app**:

```
log\electron.log        DUMATE_INAPP_KEY: '<64 hex>'
log\desktop-main\Main.log
  [OPENCODE PROXY] ... headers: map[ ... X-Dumate-Inapp-Key:[<64 hex>] ]
```

Então um processo DSH separado *consegue* lê-lo em tempo de execução (e a porta também, da linha
`doInitServices completed, result: {"backendPort":…}`). Com dois custos: o DuMate precisa estar
**em execução** para que porta e chave existam, e o formato do log é um detalhe de implementação
da versão atual (1.0.83.335) que pode mudar.

O plugin **traz** uma rota de modelo do DuMate: lê a porta e o `X-Dumate-Inapp-Key` dos logs e
encaminha por um shim local para `http://127.0.0.1:<port>/api/qianfanproxy/v1/chat/completions`
(o upstream já é compatível com OpenAI, então não há tradução de protocolo). Isso faz do DuMate a
**única plataforma de modelos que exige o cliente em execução**: se você o fechar não há porta nem
chave, e os modelos somem. O *check-in* do DuMate foi removido na 1.1.0 exatamente por isso: a
concessão diária acontece quando você abre o cliente, então não havia uma ação de resgate separada
que valesse a pena automatizar.

## Configuration reference

| Chave | Padrão | Significado |
| --- | --- | --- |
| `pythonCommand` | `python` | Executável Python que aciona o motor de registro |
| `homeDir` | `engine/` incluído | Raiz contendo `adapters/` e `bridge.py` |
| `timeoutMs` | `180000` | Tempo limite por rodada |
| `allowClaim` | `false` | Permite resgate real; `false` força somente leitura |
| `pushResult` | `true` | Injetar o resumo de uma rodada manual na sessão atual |
| `statusRoute` | `/dsh-agent-checkin` | Prefixo do endpoint HTTP de status |
| `traeProvider` | `false` | Registrar o cliente TRAE CN conectado como provedor de modelos |
| `traeIntlEnabled` | `false` | Registrar o cliente TRAE global (pode conviver com o CN) |
| `qoderCnEnabled` | `false` | Registrar o cliente Qoder CN conectado como provedor de modelos |
| `wbProvider` | `false` | Registrar o cliente WorkBuddy CN conectado como provedor de modelos |
| `wbProviderIntl` | `false` | Registrar o cliente WorkBuddy global (pode conviver com o CN) |
| `modelRoutes` | `[]` | Rotas de provedor a conectar no DSH |

`pythonCommand` / `homeDir` / `timeoutMs` / `allowClaim` / `pushResult` têm **recarga a quente**
(`volatile`): aparecem no painel de configurações do host e valem na próxima rodada sem reiniciar.
`statusRoute` / `modelRoutes` e os cinco interruptores de provedor acima não, porque são **fatos
do momento do registro**: decidem qual rota HTTP e qual provedor são registrados. Torná-los
editáveis a quente deixaria a interface mostrar «desativado» enquanto o provedor continua
montado, o que é mentira, então eles exigem reinício.

`sessionsDir` e `usageCacheSeconds` também não são `volatile`: eles são lidos uma única vez pelo
scanner de uso (o scanner é criado na fase de montagem, e os parâmetros ficam fixados nesse
momento), então alterá-los exige reiniciar o host para valer.

O TTL de atualização do ranking (6 horas) e o endereço do ranking atualmente **não são itens de
configuração**, e sim constantes em `lib/model-rank.js` (`DEFAULT_RANK_TTL_MS`, `LEADERBOARD_URL`).
Eles não foram expostos porque alterá-los só deixa o painel mais lento ou mais propenso a falhar,
nunca mais preciso — e quando você quiser mesmo atualizar com mais frequência, o botão «Atualizar
ranking» do painel é o caminho.

A **hora do check-in diário não está nesta tabela de propósito**: ela vive no registro de tarefas do
serviço Schedule do host e é gerenciada com `/checkin-schedule on HH:mm`. O plugin não mantém uma
cópia própria de `dailyTime`, porque isso inevitavelmente derivaria em duas fontes de verdade.

## Design notes

**Por que um subprocesso em vez de uma porta nativa?** As seis plataformas decifram suas credenciais
de seis maneiras diferentes (Electron at-rest AES-256-GCM, Chromium OSCrypt, AES-CBC simples,
assinatura Ed25519, automação de navegador via CDP). Essas implementações já estão endurecidas e
cobertas por execuções reais, então o plugin inclui um subconjunto selecionado desse motor
(`engine/`, MIT, © 2026 sole373) em vez de reescrevê-lo em Node: reescrever adicionaria modos de
falha sem remover nenhum. A tarefa do plugin é orquestração e apresentação.

**Por que não escrever um `LlmAdapter`?** O host já traz `@deepseek-ai/dsh-llm-pi-ai`, que cuida
do fatiamento em streaming, dos deltas de chamadas de ferramentas, da normalização de `usage`, do
mapeamento de níveis de pensamento e dos orçamentos de imagem. Reimplementar isso significaria
reimplementar um protocolo de streaming *e* disputar a mesma vaga de registro LLM, o que se desvia
silenciosamente na próxima atualização do host. Registrar uma rota é um problema de configuração,
então o plugin o resolve como tal.

Os provedores de cliente local TRAE / Qoder / WorkBuddy também usam o mesmo PiAiAdapter: a regra
não é mais flexionada. O plugin apenas sobe um shim de loopback em `127.0.0.1` (porta aleatória +
bearer aleatório) do seu próprio lado, traduzindo o protocolo privado de cada cliente para um
`/v1/chat/completions` compatível com OpenAI, e o PiAiAdapter o chama como qualquer endpoint
OpenAI. A tradução de protocolo é o único código além da configuração, e ela precisa existir:
esses clientes não expõem nenhum endpoint público para apontar, e suas credenciais vivem dentro
de um cliente de desktop conectado, não em uma chave de API. As credenciais ficam na memória do
processo e na porta de loopback: nenhum segredo novo é gravado em disco.

## Licence

MIT — para este plugin. O subconjunto `engine/` incluído também é MIT, Copyright (c) 2026 sole373;
seu aviso está em `engine/ENGINE-LICENSE.txt`, e seus `DISCLAIMER.md` / `SECURITY.md` vêm no pacote
e vinculam o uso dessa parte.
