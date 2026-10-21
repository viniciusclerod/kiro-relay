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
   Não implementar refresh próprio sem decisão explícita do dono (ver "Decisão pendente").
3. Ler o SQLite por **snapshot**: copiar `data.sqlite3` (+ `-wal`, copiado antes) para um tmp `0700`, abrir a
   cópia com `node:sqlite` e apagar em seguida (`src/auth/sqliteSnapshot.ts`).

## Convenções de código

- TypeScript com **sintaxe apagável apenas** (sem `enum`, sem parameter properties, sem `namespace`), `import type`
  para tipos e **extensão `.ts`** nos imports relativos. Assim os testes rodam direto no Node (type stripping).
- `src/extension.ts` é o único arquivo que importa `vscode`; a lógica fica em módulos puros testáveis.
- Testes: `node:test`, sem rede e sem VS Code (`npm test`). Typecheck: `npm run typecheck`. Build: `npm run build`
  (esbuild, CJS, `external: ['vscode', 'node:sqlite']`). CI: `npm ci` + typecheck + test + build.
- Commits no estilo Conventional Commits. Não fazer refatorações fora do escopo da tarefa.
- Mensagens de UI hoje estão em português; plano é migrar para inglês por padrão com `vscode.l10n`.

## Estado atual (etapa 1: autenticação, concluída e testada no F5)

Estrutura relevante: `src/extension.ts` (comandos `kirorelay.diagnose`, `kirorelay.reloadCredentials`, status bar) e
`src/auth/` (`credentials`, `kiroCliDb`, `ssoCache`, `sqliteSnapshot`, `tokenProvider`, `diagnose`, `factory`,
`paths`, `errors`, `redact`, `source`). Há `scripts/check-name.ts` (verifica nomes no Marketplace/Open VSX).

Fatos **verificados** no ambiente do dono (relatório de diagnóstico real):
- VS Code 1.142.0; extension host em Node **24.21.0** (linux/arm64); **`node:sqlite` disponível**; kiro-cli **2.33.0**.
- Banco: `~/.local/share/kiro-cli/data.sqlite3`; sem `-wal` no momento. Tabelas: `auth_kv`, `history`, `migrations`, `state`.
- `auth_kv` tem `kirocli:odic:token` (campos: `access_token, expires_at, oauth_flow, refresh_token, region, scopes, start_url`)
  e `kirocli:odic:device-registration` (`client_id, client_secret, client_secret_expires_at, oauth_flow, region, scopes`).
  `state` tem `api.codewhisperer.profile` (`arn, device_code_disabled, profile_name`).
- Login é **IdC / DeviceCode** com registro de cliente OIDC. `~/.aws/sso/cache` **não existe** no container.
- O parser tolera snake_case/camelCase; timestamps têm nanossegundos (truncar a fração para 3 dígitos).

**Pode estar pendente** (confira com `git status`/`git log`): um patch que melhora o diagnóstico: linha `agora:`, tempo restante do
access token, **fingerprint do refresh token** (detecta rotação), `client_secret_expires_at` do registro OIDC, e um teste com o
layout real acima (valores fictícios). Se não estiver aplicado, reimplemente.

## Decisão pendente: como manter o token válido

O token observado expira em poucos minutos (tempo de vida total ainda **desconhecido**, possivelmente ~20 min). Com a política
"só reler", a extensão ficaria em "token expirado" sempre que o kiro-cli não for usado. Opções:
- **A.** Cooperativo puro (pedir ao usuário que use o kiro-cli). Ruim com token curto.
- **B.** A extensão executa um comando barato do kiro-cli que renove o token e relê o banco (preferida, mantém dependência exclusiva do CLI).
- **C.** Refresh próprio via AWS SSO OIDC (`CreateToken`, grant `refresh_token`, com `client_id/secret` do registro) e gravar de volta. Arriscada.

**Experimento a fazer com o dono:** aguardar o vencimento real, rodar candidatos (`kiro-cli whoami` se existir, `kiro-cli doctor`, por fim
`kiro-cli chat` com uma mensagem curta) e, após cada um, comparar fingerprints (access e refresh) e `expires_at` no diagnóstico. Isso
revela qual comando renova, o tempo de vida real e se o refresh token rotaciona. Registrar o resultado aqui.

### Resultado do experimento (2026-10-21, kiro-cli 2.33.0, IdC/DeviceCode, em andamento)

- `kiro-cli whoami`, `profile`, `chat --list-models` e `chat --no-interactive` existem. Rodados em sequência às ~04:36 (sem
  verificação entre eles), **um deles renovou o access token** (fingerprint mudou), mas o `expires_at` ficou igual (+164 ms) e o
  **refresh token não rotacionou**. Uma gravação anterior (04:31) também manteve o mesmo `expires_at`.
- Às 04:38, depois do vencimento, `kiro-cli whoami` respondeu "Not logged in" e **o kiro-cli apagou `kirocli:odic:token`** do banco
  (manteve `device-registration`). Ou seja, o kiro-cli grava no banco ao renovar e ao desistir.
- Novo `kiro-cli login --use-device-flow` às 04:39:47: `expires_at` = login + **~60 min**; refresh token novo; registro OIDC reaproveitado
  (`client_secret_expires_at` não muda no login, então não serve para datar o login).
- Hipótese (não confirmada): **teto de ~1 h por login**; renovações trocam o access token sem estender o prazo. Pode ser a duração de
  sessão do IdC da organização. Em confirmação: monitorar o banco até depois do vencimento e rodar `whoami` isolado antes dele.

## Próximas etapas (ordem)

1. Resolver a decisão acima (experimento, implementar A/B/C escolhida, testes).
2. **Spike** do cliente `@aws/codewhisperer-streaming-client` (pacote oficial da AWS, v1.0.45 na última checagem; o Kiro IDE parece usar
   esse cliente). Verificar: opção `endpoint`/`token`; se aceita os campos do Kiro (`additionalModelRequestFields`, `reasoningContent`);
   injeção de headers por `middlewareStack`; tamanho no bundle. Se não servir, usar `@smithy/eventstream-codec` + `fetch`.
3. Catálogo de modelos (`ListAvailableModels`, REST) e `provideLanguageModelChatInformation`.
4. Chat só texto com streaming (`provideLanguageModelChatResponse`), `provideTokenCount` (estimativa).
5. Tool calling, imagens, variantes de esforço (`modelo:nivel` como itens separados no picker).
6. i18n (inglês padrão), ícone, LICENSE (nome), CHANGELOG, publicação (Marketplace + **Open VSX**, usado pelo Kiro IDE).

## Referência do protocolo do Kiro (engenharia reversa, **não oficial**)

Fonte: projeto `kirogo` (MIT), https://github.com/jasminnanda/kirogo, especialmente `docs/INTERNALS.md` e `internal/kiro/*`.
Tratar como observação, não como contrato; o backend muda sem aviso.

- Dois hosts: chat em `runtime.{region}.kiro.dev` (operação `GenerateAssistantResponse`; headers `x-amz-target` e
  `content-type: application/x-amz-json-1.0`); catálogo em `management.{region}.kiro.dev` (`ListAvailableModels`, REST, **sem** esses headers;
  enviar os do runtime ali dá 404).
- Auth: bearer + header `TokenType` conforme o tipo de login. Headers do cliente: `x-amzn-kiro-agent-mode: vibe`, `Origin` do corpo `AI_EDITOR`,
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
  nomes ≤ 64 caracteres.
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

## Itens não verificados (não presumir)

- Existência de `kiro-cli whoami` e qual comando força o refresh do token.
- Superfície real do `@aws/codewhisperer-streaming-client` (nomes de classes/comandos, tipos dos campos do Kiro).
- Comportamento do `fetch`/SDK atrás do proxy corporativo no extension host.
- Se `node:sqlite` existe no VS Code **desktop local** (só confirmado no VS Code Server do devcontainer).
- Em sessões remotas (devcontainer/WSL/SSH) a extensão roda **no lado remoto** e lê credenciais de lá; avaliar `extensionKind` no futuro.