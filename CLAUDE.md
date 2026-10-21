# Kiro Relay: contexto do projeto (leia antes de qualquer tarefa)

Extensão do VS Code que expõe os modelos de uma assinatura **Kiro** como **provedor de modelos de
linguagem** (`vscode.lm.registerLanguageModelChatProvider`) no Chat do VS Code, autenticando
**exclusivamente via `kiro-cli`** (a extensão não tem login próprio).

- Repositório: https://github.com/viniciusclerod/kiro-relay
- Extensão: `viniciusclerod.kiro-relay`. Prefixo de comandos/settings: `kirorelay.`. Futuro `vendor` do provedor: `kirorelay`.
- Não afiliada ao Kiro/AWS. "Kiro" é marca de terceiros: manter o aviso no README e na descrição.

## Como trabalhamos

- O dono **não tem Node na máquina**; tudo roda no **devcontainer** (usuário `vscode`, Node 22, kiro-cli em
  `~/.local/bin`, login feito dentro do container com `kiro-cli login --use-device-flow`, sem volume).
- Ambiente corporativo: registry/espelhos internos e CA própria (`NODE_EXTRA_CA_CERTS` já definido). Proxy
  pode afetar chamadas HTTPS do extension host.
- Responda em **português**. Pergunte quando houver decisão real; não invente fatos sobre o protocolo do Kiro.
- Depois de cada etapa, diga **como testar no VS Code** (F5, comandos, o que esperar).

## Regras de segurança (inegociáveis)

1. **Nunca** imprimir, logar, commitar ou colar valores de token, refresh token, client secret ou o conteúdo
   de `~/.local/share/kiro-cli/data.sqlite3`. Para diagnóstico use só nomes de campos, datas e **fingerprint**
   (8 hex do SHA-256). Os testes usam valores fictícios.
2. **Somente leitura e cooperativo** com o kiro-cli: nunca escrever no banco do kiro-cli. Os refresh tokens
   do Kiro são **de uso único**: renovar por fora pode invalidar o token do kiro-cli e deslogá-lo.
   Não implementar refresh próprio sem decisão explícita do dono (ver "Decisão: como manter o token válido").
3. Ler o SQLite por **snapshot**: copiar `data.sqlite3` (+ `-wal`, copiado antes) para um tmp `0700`, abrir a
   cópia com `node:sqlite` e apagar em seguida (`src/auth/sqliteSnapshot.ts`).

## Convenções de código

- TypeScript com **sintaxe apagável apenas** (sem `enum`, sem parameter properties, sem `namespace`), `import type`
  para tipos e **extensão `.ts`** nos imports relativos. Assim os testes rodam direto no Node (type stripping).
- `src/extension.ts` é o único arquivo que importa `vscode`; a lógica fica em módulos puros testáveis.
- Testes: `node:test`, sem rede e sem VS Code (`npm test`). Typecheck: `npm run typecheck`. Build: `npm run build`
  (esbuild, CJS, `external: ['vscode', 'node:sqlite']`). CI: `npm ci` + typecheck + test + build.
- Commits no estilo Conventional Commits. Não fazer refatorações fora do escopo da tarefa.
- **Idioma (decisão do dono, 2026-10-21): inglês é o idioma oficial** do produto e do código: textos de UI (fonte), logs,
  relatório de diagnóstico, mensagens de erro, comentários, nomes de testes, README e CONTRIBUTING. Só este CLAUDE.md e a conversa
  com o dono ficam em português. A **UI é traduzida para pt-BR**: `vscode.l10n.t('texto em inglês')` só em `extension.ts`, com a
  tradução em `l10n/bundle.l10n.pt-br.json`; o manifesto usa `%chave%` com `package.nls.json` e `package.nls.pt-br.json`.
  **Logs e diagnóstico não são traduzidos.** Os módulos puros geram mensagens em inglês (servem para log); a UI traduz a partir do
  `code`/campos dos erros. `test/l10n.test.ts` falha se faltar tradução ou se os placeholders divergirem.

## Estado atual

- **Etapa 1, autenticação:** concluída e testada no F5. O diagnóstico mostra `agora:`, o tempo restante do access token, os
  fingerprints do refresh token e do `client_id`, e o `client_secret_expires_at`.
- **Etapa 3, catálogo e provedor:** implementada e verificada no F5 (catálogo carregado no extension host).
- **Etapa 4/5, chat:** implementado (texto com streaming, tool calling, imagens, esforço, raciocínio quando o VS Code expõe
  `LanguageModelThinkingPart`) e **verificado no F5 (2026-10-21)**: texto (Qwen3 Coder Next), modo Agent com ~84 tools e chamadas
  de ferramenta (Claude Opus 5.5, esforço low pelo seletor) e imagem. Com imagem anexada, o VS Code demora no próprio pré-processamento
  ("Optimized tool selection") antes de chamar o provedor; não é atraso da extensão. Módulos puros em
  `src/chat/`: `eventstream.ts` (decodificador próprio, sem dependências), `request.ts` (corpo + regras estruturais),
  `response.ts` (eventos), `client.ts` (HTTP + tentativas só antes da primeira saída), `vscodeMessages.ts` (conversão por formato).
  `src/models/catalog.ts` (puro) e o registro `vscode.lm.registerLanguageModelChatProvider('kirorelay', …)` em `extension.ts`.
  `provideTokenCount` é uma estimativa (~4 caracteres/token). Verificado no F5: grupo "Kiro" no seletor com os 20 modelos.

Textos ao dono continuam em português; o código e o produto, em inglês (ver Convenções).

Estrutura relevante: `src/extension.ts` (comandos `kirorelay.diagnose`, `kirorelay.reloadCredentials`, `kirorelay.refreshModels`,
`kirorelay.manage` (managementCommand do provedor), status bar, provedor de modelos), `src/auth/` (`credentials`, `kiroCliDb`,
`ssoCache`, `sqliteSnapshot`, `tokenProvider`, `diagnose`, `factory`, `paths`, `errors`, `redact`, `source`) e `src/models/catalog.ts`.
Há `scripts/check-name.ts` (verifica nomes no Marketplace/Open VSX).

Dica do ambiente: o bind mount do devcontainer no macOS às vezes entrega um arquivo recém-editado pela metade; se os testes falharem
logo após uma edição feita fora do container, rode de novo.

Fatos **verificados** no ambiente do dono (relatório de diagnóstico real):
- VS Code 1.142.0; extension host em Node **24.21.0** (linux/arm64); **`node:sqlite` disponível**; kiro-cli **2.33.0**.
- Banco: `~/.local/share/kiro-cli/data.sqlite3`; sem `-wal` no momento. Tabelas: `auth_kv`, `history`, `migrations`, `state`.
- `auth_kv` tem `kirocli:odic:token` (campos: `access_token, expires_at, oauth_flow, refresh_token, region, scopes, start_url`)
  e `kirocli:odic:device-registration` (`client_id, client_secret, client_secret_expires_at, oauth_flow, region, scopes`).
  `state` tem `api.codewhisperer.profile` (`arn, device_code_disabled, profile_name`).
- Login é **IdC / DeviceCode** com registro de cliente OIDC. `~/.aws/sso/cache` **não existe** no container.
- O parser tolera snake_case/camelCase; timestamps têm nanossegundos (truncar a fração para 3 dígitos).

Catálogo verificado com chamada real (2026-10-21):
- `GET https://management.us-east-1.kiro.dev/ListAvailableModels?origin=AI_EDITOR&profileArn=…` com `Authorization: Bearer`,
  `Accept: application/json` e **User-Agent honesto (`kiro-relay/…`)**: 200. **Não** precisa de `TokenType` nem de imitar o Kiro IDE.
  Com token vencido a resposta é **403 `{"message":"Invalid token"}`**.
- Resposta: `{models[], defaultModel{modelId:"auto"}, nextToken}` (1 página, 20 modelos). Campos por modelo: `modelId, modelName,
  description, modelProvider, rateMultiplier, rateUnit ("Credit"), tokenLimits{maxInputTokens,maxOutputTokens}, supportedInputTypes
  (["TEXT","IMAGE"]), promptCaching{supportsPromptCaching,…}, additionalModelRequestFieldsSchema, refusalFallbackModels, status,
  consentStatus, availableOrigins, disclaimers, termsUrl`. `status`/`consentStatus`/`availableOrigins` vieram todos `null`.
- O kiro-cli usa o mesmo host para listar modelos (log `-vvv`, serviço `KiroControlPlaneBearer`).

Uso de créditos verificado com chamada real (2026-10-21): `GET https://management.us-east-1.kiro.dev/getUsageLimits?origin=AI_EDITOR&
profileArn=…` (mesmos headers do catálogo) → `{subscriptionInfo{subscriptionTitle:"KIRO PRO", type, overageCapability, ...},
nextDateReset (epoch s), overageConfiguration{overageStatus}, usageBreakdownList[{resourceType:"CREDIT", displayNamePlural,
currentUsage(WithPrecision), usageLimit(WithPrecision), bonuses[], freeTrialInfo, overageRate, ...}], userInfo}`. **`userInfo`
identifica o usuário: nunca logar nem guardar.** Regras copiadas do Kiro IDE (`kiro.kiro-agent`): percentual = floor(used/limit·100),
limite ≥ 999999 = sem limite, bônus listados à parte (free trial `ACTIVE` = "Welcome bonus"; bonuses `ACTIVE`/`EXHAUSTED`).
Implementado em `src/kiro/usage.ts`; tooltip rico da barra de status + linha no menu. **Atraso medido: o backend reflete o consumo
30 a 60 s depois** (8,69 → 8,70 entre +31 s e +62 s após uma requisição de 0,008 crédito); por isso atualiza a cada 5 min e aos 20 s e
75 s após a última resposta do chat. `currentUsageWithPrecision` tem 2 casas. Percentual: 1 casa abaixo de 10% (arredonda para baixo).

Consumo por interação (decisão do dono, 2026-10-21: primeiro no chat + painel; depois **só no painel**, porque ao lado do nome do
modelo não é possível): créditos do `meteringEvent` e % de contexto do
`contextUsageEvent` (tokens ≈ % × `maxInputTokens`; **o Kiro não informa tokens exatos**). Rodapé em itálico ao fim da resposta final
(sem tool call), somando os passos do modo Agent: a interação é identificada pelo hash das mensagens até a última mensagem de texto do
usuário (`src/chat/turnUsage.ts`). O rodapé vai entre separadores invisíveis U+2063 e é removido em `fromVsCodeMessages` antes de
reenviar (os separadores ficam **dentro** dos `*`, senão o itálico não fecha). O canal "usage" do Chat (o que aparece junto do nome do
modelo) é alimentado pelo **participante** (`stream.usage`, Copilot), não pelo provedor: o rodapé na resposta é o mais perto possível.
- **Fim da sessão do IdC (estimativa, `src/auth/session.ts`):** o backend não informa. Refresh token novo (fingerprint) visto com token
  de ≥55 min = login agora → fim ≈ login + `kirorelay.auth.sessionHours` (8). Renovação recente (≤3 min) que devolve token de <50 min =
  token cortado pelo fim da sessão → fim exato. Guardado em `globalState['kirorelay.session']` (só fingerprint). Mostrado como tempo
  restante ("restam …"), nunca hora do relógio: o extension host pode estar em UTC.
- **Barra de status (decisão do dono):** só o ícone do Kiro (+ ⚠/⛔); hover = painel; clique = `kirorelay.refreshPanel` (relê token,
  sessão e créditos em silêncio), porque abrir o hover no clique não é possível para extensões; o menu fica no link "Menu" do painel.
  Barra de progresso: **imagem SVG `data:`** (mídia `data:` é permitida no hover) com `width="100%" height="4"`, cantos
  arredondados, como a do Copilot. Imagem não lê cores do tema: cores por `ColorThemeKind` (`barColorsFor`), redesenhada em
  `onDidChangeActiveColorTheme`. A troca de texto no hover do Copilot (créditos ↔ %) é DOM dinâmico, impossível em hover de
  extensão: percentual grande à esquerda e "usados / limite" à direita na mesma linha (o `title` não ficou perceptível).
- **Raciocínio (F5, 2026-10-21):** o modelo `auto` manda um `reasoningContentEvent` com `"..."` (raciocínio oculto). Um
  `ThinkingPart` nunca fechado prendeu a resposta no bloco "Completed N steps". Regra: ignorar raciocínio só com pontos/espaços e
  **fechar** o bloco com `ThinkingPart('', undefined, { vscode_reasoning_done: true })` antes de texto, tool call ou fim (como o Copilot).

Chat verificado com chamadas reais (2026-10-21, ~0,03 crédito no total):
- `POST https://runtime.us-east-1.kiro.dev/generateAssistantResponse` com `Content-Type: application/x-amz-json-1.0`,
  `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`, `x-amzn-kiro-agent-mode: vibe`, bearer e
  **User-Agent honesto**; sem `TokenType`. Resposta 200 `application/vnd.amazon.eventstream`.
- Eventos vistos: `assistantResponseEvent {content, modelId}`, `toolUseEvent {toolUseId, name, input (fragmento), stop}` (argumentos
  picados em vários eventos), `metadataEvent {stopReason: "END_TURN"}`, `contextUsageEvent`, `meteringEvent {usage, unit: "credit"}`.
- `additionalModelRequestFields: {reasoning: {effort: "low"}}` aceito (GPT 5.6 Luna). Histórico com `toolUses` e `toolResults`
  pareados, e system prompt dobrado no primeiro turno, aceitos (Qwen3 Coder Next).

## Decisão: como manter o token válido

**Decidido pelo dono em 2026-10-21: opção B**, comando configurável (`kirorelay.auth.renewCommand`, padrão `["whoami"]`, `[]` desliga),
renovação sob demanda **e** pela verificação periódica da barra de status (a cada 60 s). Implementação: `src/auth/renewer.ts`
(`execFile` sem shell, timeout 20 s, single-flight, no máximo uma execução por minuto, **saída descartada** porque contém o e-mail;
nunca logar `err.message`, que inclui o stderr) e o gancho `renew` em `KiroCliTokenProvider`: sem token utilizável mas com um token
vencido/na margem, roda o renovador e relê uma vez; se o kiro-cli não trocou um token que ainda vale mais de 30 s, usa-o mesmo assim
(o `whoami` só renova perto do vencimento). Sem nenhuma credencial, não roda nada (só `kiro-cli login` resolve). `cli.path` e
`renewCommand` têm `scope: machine`, para um workspace não poder escolher o executável. **Verificado com o kiro-cli real
(2026-10-21 16:30):** token vencido às 16:30:20; o provedor rodou `kiro-cli whoami` (exit 0, ~5 s), releu e obteve token novo
valendo até 17:30:47. Opções originais:
- **A.** Cooperativo puro (pedir ao usuário que use o kiro-cli). Ruim com token curto.
- **B.** A extensão executa um comando barato do kiro-cli que renove o token e relê o banco (preferida, mantém dependência exclusiva do CLI).
- **C.** Refresh próprio via AWS SSO OIDC (`CreateToken`, grant `refresh_token`, com `client_id/secret` do registro) e gravar de volta. Arriscada.

**Experimento a fazer com o dono:** aguardar o vencimento real, rodar candidatos (`kiro-cli whoami` se existir, `kiro-cli doctor`, por fim
`kiro-cli chat` com uma mensagem curta) e, após cada um, comparar fingerprints (access e refresh) e `expires_at` no diagnóstico. Isso
revela qual comando renova, o tempo de vida real e se o refresh token rotaciona. Registrar o resultado aqui.

### Resultado do experimento (2026-10-21, kiro-cli 2.33.0, IdC/DeviceCode)

Medido com o diagnóstico (só fingerprints e datas) e um monitor da data de modificação do banco.

- **Tempo de vida do access token: ~60 min.** Login às 04:39:47 → `expires_at` 05:39:45.
- **`kiro-cli whoami` renova o token, mas só depois do vencimento.** Às 04:42 (57 min restantes) e às 05:34 (5,7 min restantes) ele
  gravou no banco sem trocar o token. Às 05:40:35 (50 s após vencer) trocou o access token e o novo vence em +60 min (06:40:32).
  Não sabemos o limiar exato (entre 0 e ~5 min antes do vencimento).
- **O refresh token não rotacionou** em nenhuma renovação observada (mesmo fingerprint antes e depois). Continua não sendo seguro
  presumir que pode ser reutilizado por fora.
- **Fim de sessão:** numa sessão anterior (login de horário desconhecido), renovações trocaram o access token sem estender o
  `expires_at`, e depois do vencimento `whoami` respondeu "Not logged in" e **o kiro-cli apagou `kirocli:odic:token`** (manteve
  `device-registration`). Interpretação provável: a renovação é limitada ao fim da sessão do IAM Identity Center; a duração da
  sessão da organização é desconhecida.
- O kiro-cli grava no banco até em `whoami` sem renovação. `client_secret_expires_at` não muda no login (registro reaproveitado).
- `kiro-cli whoami`, `profile`, `chat --list-models` e `chat --no-interactive` existem; `whoami` é o mais barato que renova.
- O tempo de vida **varia** porque é cortado no fim da sessão: uma renovação às 12:08:47 gerou um token que vencia às 12:39:36 (~31 min),
  exatamente **8 h** depois do login das 04:39:47. Às 14:30 a renovação falhou e o kiro-cli apagou o token.
- **Conclusão: sessão do IAM Identity Center de 8 h** (padrão da AWS), e nenhuma renovação passa disso. Depois, só `kiro-cli login`.
  A primeira sessão observada (fim às 04:37) é compatível com um login às ~20:37 do dia anterior.
- No F5 (14:30), o extension host listou os 20 modelos atrás do proxy corporativo, e a lista recarregou sozinha quando o token voltou a ser válido.

## Próximas etapas (ordem)

1. ~~Experimento do token~~ e ~~renovação via kiro-cli (opção B)~~: feitos.
2. ~~**Spike**~~ (feito: decodificador próprio, ver "Itens não verificados") do cliente `@aws/codewhisperer-streaming-client` (pacote oficial da AWS, v1.0.45 na última checagem; o Kiro IDE parece usar
   esse cliente). Verificar: opção `endpoint`/`token`; se aceita os campos do Kiro (`additionalModelRequestFields`, `reasoningContent`);
   injeção de headers por `middlewareStack`; tamanho no bundle. Se não servir, usar `@smithy/eventstream-codec` + `fetch`.
3. ~~Catálogo de modelos (`ListAvailableModels`, REST) e `provideLanguageModelChatInformation`.~~ Feito e verificado no F5.
4. ~~Chat só texto com streaming~~ e 5. ~~tool calling, imagens, esforço~~: implementados e verificados no F5. Pendências: teto local
   de saída (o backend não tem `max_tokens`), retry sem raciocínio em `THINKING_SIGNATURE_INVALID`, `thinking.type`/`max_tokens` do
   schema, contagem de tokens real.
6. ~~i18n (inglês padrão + pt-BR)~~ feito. Ícone, LICENSE (nome), CHANGELOG, publicação (Marketplace + **Open VSX**, usado pelo Kiro IDE).

## Referência do protocolo do Kiro (engenharia reversa, **não oficial**)

Fonte: projeto `kirogo` (MIT), https://github.com/jasminnanda/kirogo, especialmente `docs/INTERNALS.md` e `internal/kiro/*`.
Tratar como observação, não como contrato; o backend muda sem aviso.

- Dois hosts: chat em `runtime.{region}.kiro.dev` (operação `GenerateAssistantResponse`; headers `x-amz-target` e
  `content-type: application/x-amz-json-1.0`); catálogo em `management.{region}.kiro.dev` (`ListAvailableModels`, REST, **sem** esses headers;
  enviar os do runtime ali dá 404).
- Auth: bearer + header `TokenType` conforme o tipo de login (no catálogo, com login IdC, **não** foi necessário). Headers do cliente: `x-amzn-kiro-agent-mode: vibe`, `Origin` do corpo `AI_EDITOR`,
  User-Agent com versão do Kiro e fingerprint da máquina.
- Corpo: `conversationState{chatTriggerType:"MANUAL", conversationId, currentMessage.userInputMessage{content, modelId, origin, images,
  userInputMessageContext{tools, toolResults}}, history[]}`, `profileArn`, `additionalModelRequestFields`.
- **System prompt** vai **dobrado no primeiro turno do usuário**: o campo `systemPrompt` é rejeitado ou ignorado pelo backend.
- Esforço de raciocínio: em `additionalModelRequestFields`, sob a chave `output_config` **ou** `reasoning` (depende do modelo; descobrir pelo
  `additionalModelRequestFieldsSchema` do catálogo).
- Raciocínio no histórico exige assinatura válida; sem assinatura ou de outro modelo, **descartar**. Em `THINKING_SIGNATURE_INVALID`,
  refazer uma vez sem raciocínio. O VS Code provavelmente não devolve a assinatura, então descartar o raciocínio do histórico.
- Regras estruturais (senão "Improperly formed request."): conteúdo nunca vazio (placeholder), papéis alternados começando por usuário,
  tool result sempre pareado com a tool call, schemas de tools sem `additionalProperties` e sem `required` vazio, descrição de tool não vazia,
  nomes ≤ 64 caracteres. **Verificado no F5 (2026-10-21):** o schema de entrada de toda tool precisa ter `type: "object"` no topo; senão o
  Bedrock responde 400 "toolConfig.tools.N.toolSpec.inputSchema.json.type must be one of the following: object" (algumas tools do modo
  Agent do VS Code mandam `{}` ou omitem `type`). `toolInputSchema()` em `src/chat/request.ts` normaliza.
- Resposta: `vnd.amazon.eventstream` binário. Eventos úteis: `assistantResponseEvent`, `reasoningContentEvent`, `toolUseEvent`
  (argumentos em **fragmentos** por `toolUseId` até `stop:true`), `contextUsageEvent`, `meteringEvent`; `metadataEvent` raramente.
- O backend **não** tem `max_tokens`: aplicar o teto localmente (exceto em tool calls, que devem chegar inteiras).
- Resiliência: 403 → recarregar credenciais; sem primeiro token em ~15 s → repetir; depois do primeiro byte nunca repetir.

## API do VS Code usada

Doc: https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider · amostra:
`microsoft/vscode-extension-samples/chat-model-provider-sample`. `engines.vscode: ^1.104.0`.
Contribuição `contributes.languageModelChatProviders` (`vendor`, `displayName`, `managementCommand`). Interface com
`provideLanguageModelChatInformation(options{silent}, token)`, `provideLanguageModelChatResponse(model, messages, options, progress, token)`,
`provideTokenCount(model, text, token)`. Partes de resposta estáveis: `LanguageModelTextPart`, `LanguageModelToolCallPart`,
`LanguageModelToolResultPart` (raciocínio/thinking exige APIs propostas; fora de escopo). Com `silent: true`, nunca abrir prompts.

**Esforço de raciocínio (decisão do dono, 2026-10-21): schema nativo + setting de reserva.** O VS Code 1.142 aceita
`configurationSchema` em `LanguageModelChatInformation` **sem checar proposta** (diferente de `isDefault`/`editTools`, que exigem
`chatProvider`) e mostra no seletor um menu por propriedade com `enum` (lê `title`, `default`, `enumItemLabels`, `enumDescriptions`; o painel "Details" do seletor só mostra propriedades com `group` "navigation" ou "tokens" e enum com 2+ itens; fora dele, o menu fica no clique direito do modelo em "Manage Language Models").
A escolha chega em `provideLanguageModelChatResponse` como `options.modelConfiguration`, **já preenchida com o `default`** do schema.
Não está no `@types/vscode` (1.140 é a última): é API proposta, pode mudar. Implementação em `src/models/effort.ts`: lê
`output_config.effort` (Claude) ou `reasoning.effort` (GPT) do catálogo; precedência seletor (se diferente do padrão) > setting
`kirorelay.reasoningEffort` > padrão do backend. `thinking.type`/`display` e `max_tokens` do schema ainda não são expostos.

## Ícone / logo (decisão do dono, 2026-10-21)

- **A aba do provedor no seletor não aceita ícone de extensão**: o VS Code 1.142 escolhe o ícone da aba pelo `displayName`
  comparando com uma lista fixa de marcas (Copilot, Claude/Anthropic, Gemini/Google, OpenAI/GPT, Grok/xAI, Kimi, Microsoft);
  "Kiro" cai no ✨ genérico. `contributes.languageModelChatProviders` não tem campo de ícone.
- O que dá: `statusIcon` (ThemeIcon) em cada modelo, campo proposto que o runtime repassa sem checar proposta; aparece no botão do
  modelo no campo do Chat (e provavelmente nas linhas do seletor). Ícone próprio via `contributes.icons` + fonte `.woff`.
- **Logo**: `media/kiro.svg` copiado do app Kiro (`/Applications/Kiro.app/.../kiro.kiro-agent/packages/kiricons/src/kiro.svg`,
  pacote `@kiro/kiricons`, **licença AWS-IPL**). O dono decidiu usá-lo mesmo assim, ciente da licença. README avisa que o logo não é
  MIT. O `.svg` não vai no `.vsix` (só a fonte). Fonte: `npm run build:icons` (`scripts/build-icons.mjs`, svgicons2svgfont → svg2ttf
  → ttf2woff, reproduzível); commitar `media/kirorelay-icons.woff` ao mudar o SVG. Monocromático: o tema pinta (claro/escuro/HC).
- **Painel no clique, como o do Copilot: não é possível para extensões (1.142).** O item do Copilot usa o comando interno
  `statusBar.entry.showTooltip`, comparado por **identidade de objeto** no workbench; um id igual vindo de extensão não funciona.
  `StatusBarItem.tooltip2` exige a proposta `statusBarItemTooltip`. O equivalente possível é o **hover** (MarkdownString com
  `supportThemeIcons` e `isTrusted.enabledCommands`): abre ao passar o mouse, fica fixo e aceita cliques. O clique abre o QuickPick.
- **Hover em Markdown (1.142):** só `<span style>` com `color`, `background-color` (aceita `var(--vscode-…)`), `display:inline-block`
  e `border-radius`, **nessa ordem**; sem largura nem tamanho de fonte. Barra de progresso = spans coloridos com `&nbsp;` (largura por
  caracteres). Tabelas com `|:--|--:|` alinham à direita. A data de renovação sai em UTC, só o dia: o extension host pode estar num
  container em UTC.
- **Painel em HTML (`src/ui/panel.ts`):** o sanitizador do hover aceita `table/td` com `width`, `align`, `colspan`, `hr`, `h1`–`h6`,
  `small`, `a href` e `<span class="codicon codicon-…">`. Uma tabela `width="100%"` por seção + `<hr>` dá o esqueleto do Copilot
  (rótulo à esquerda, valor `align="right"`). Dentro de HTML o `$(icon)` não é processado: usar o span codicon. Barra fina com `━`
  colorido (`color:` é permitido em span). `test/panel.test.ts` valida o HTML contra as regras do sanitizador 1.142.
- **Settings em seções** (`contributes.configuration` como lista: Login, Autenticação, kiro-cli, Chat). Escopos: `login.*` e
  `auth.renewCommand` = `application` (aparecem na aba User mesmo em janela remota; workspace não sobrescreve); `cli.path` = `machine`
  (caminho por máquina: em janela remota aparece na aba **Remote**).
- Login configurável: `kirorelay.login.{license,startUrl,region,deviceFlow}` (scope `application`) → `src/auth/login.ts` monta e valida
  `kiro-cli login [--license] [--identity-provider] [--region] [--use-device-flow]`; o terminal roda o kiro-cli **como processo**
  (`shellPath`/`shellArgs`, sem shell, sem injeção). O start URL do login atual vem de `start_url` do token (não é segredo; mostrado
  no hover, **não** no diagnóstico).
- `managementCommand` está **obsoleto** no 1.142 (ainda funciona); migrar quando mexer no manifesto.

## Itens não verificados (não presumir)

- Limiar exato em que o `kiro-cli` passa a renovar (entre 0 e ~5 min antes do vencimento).
- Decisão do spike (2026-10-21): **não** usar `@aws/codewhisperer-streaming-client` (puxa ~15 pacotes @smithy/@aws-sdk para um
  decodificador de ~100 linhas); decodificador próprio em `src/chat/eventstream.ts`.
- Comportamento do SDK/streaming atrás do proxy corporativo (o `fetch` do extension host funcionou para o catálogo).
- Como o seletor de modelos do Chat apresenta `detail`/`tooltip` e se `toolCalling: true` sem chat implementado causa efeitos colaterais.
- Se `node:sqlite` existe no VS Code **desktop local** (só confirmado no VS Code Server do devcontainer).
- Em sessões remotas (devcontainer/WSL/SSH) a extensão roda **no lado remoto** e lê credenciais de lá; avaliar `extensionKind` no futuro.