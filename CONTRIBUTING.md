# Contribuindo com o Kiro Relay

Provedor de modelos de linguagem para o VS Code que usa **somente** a autenticação do `kiro-cli`.

**Etapa atual: 1 de N, autenticação.** Ainda não há provedor de modelos nem chat. Esta etapa
entrega a leitura segura das credenciais do kiro-cli, um comando de diagnóstico e um indicador na
barra de status.

## Princípios de segurança (valem para as próximas etapas)

- **Somente leitura e cooperativo.** Os refresh tokens do Kiro são de uso único: renovar por fora
  pode invalidar o token guardado pelo kiro-cli e deslogá-lo. Por isso a extensão **nunca renova**
  o token. Perto do vencimento ela relê as fontes, porque o kiro-cli pode já ter renovado.
- **Snapshot do banco.** O `data.sqlite3` do kiro-cli é copiado (junto com o `-wal`) para um
  diretório temporário privado e a cópia é aberta. O original nunca é aberto, então nada é criado
  ou travado ao lado dele. A cópia é apagada logo depois.
- **Sem segredos em log, relatório ou disco.** Diagnósticos mostram só nomes de campos, datas e um
  fingerprint curto (8 hex do SHA-256).

## Desenvolvimento com devcontainer (recomendado)

Você só precisa de **VS Code + extensão Dev Containers + Docker**. Não é preciso Node na máquina.

1. Abra a pasta no VS Code e escolha **Dev Containers: Reopen in Container**.
2. Aguarde o `postCreateCommand`: ele roda `npm install` e instala o kiro-cli em `~/.local/bin`.
3. No terminal do container, faça o login (fluxo por código de dispositivo, sem navegador no container):
   ```bash
   /home/node/.local/bin/kiro-cli login --use-device-flow
   ```
   Abra a URL mostrada no navegador do seu computador e informe o código. O login fica num
   volume nomeado e **sobrevive a rebuilds** do container.
4. Rode `npm test` e `npm run typecheck` no terminal.
5. Siga "Testar no VS Code" abaixo.

> **Por que logar dentro do container?** No VS Code remoto (devcontainer, WSL, SSH) a extensão em
> desenvolvimento roda **dentro do container** e lê os arquivos **de lá**, não os do seu host.
> A alternativa de reaproveitar o login do host (bind mount somente leitura) está documentada,
> comentada, no final do `.devcontainer/devcontainer.json`.

### Primeiro commit

O repositório é `https://github.com/viniciusclerod/kiro-relay`. Depois do primeiro `npm install`
no devcontainer (que gera o `package-lock.json`):

```bash
git add .
git commit -m "feat: autenticação via kiro-cli"
git push -u origin main
```

Faça commit do `package-lock.json` gerado pelo primeiro `npm install` (o CI usa `npm ci`).
Falta ainda preencher o nome no `LICENSE`. O `publisher` está como `viniciusclerod`: crie esse publisher
no Marketplace (e o namespace no Open VSX) antes de publicar, ou troque o valor.

## Escolher o nome

```bash
npm run check-name -- "Nome A" "Nome B"
```

Consulta o VS Code Marketplace e o Open VSX (registro usado pelo Kiro IDE). Sem resultado não
significa disponível: a prova final é reservar o ID `publisher.nome` ao publicar.

## Sem devcontainer

Requisitos: VS Code 1.104+, Node 22.18+ e kiro-cli instalado e logado.

## Comandos

```bash
npm install
npm test            # 26 testes da camada de autenticação (sem rede, sem VS Code)
npm run typecheck   # tsc --noEmit
npm run build       # gera dist/extension.js com esbuild
```

## Testar no VS Code

1. Com a pasta aberta (no devcontainer, se for o caso), pressione **F5** (configuração "Run Extension"). Abre uma janela
   **[Extension Development Host]** (no devcontainer, ela também roda dentro do container).
2. Nessa janela: `Ctrl/Cmd+Shift+P` → **Kiro Relay: Diagnose Authentication**.
3. Leia o painel **Output → "Kiro Relay"**. Use "Copiar relatório" no aviso que aparece.
4. Na barra de status (canto direito) deve aparecer algo como `✓ Kiro 55 min`.

### Roteiro de testes manuais

| # | Cenário | Esperado |
|---|---|---|
| 1 | kiro-cli logado, token válido | `✓ Kiro N min`; diagnóstico com "OK: token válido obtido" |
| 2 | `kiro-cli logout`, depois **Kiro Relay: Reload Credentials** | `⚠ Kiro: login necessário`; diagnóstico lista o que foi procurado e onde |
| 3 | `kiro-cli login --use-device-flow` (no devcontainer), depois **Reload Credentials** | volta a `✓` |
| 4 | Token vencido sem usar o kiro-cli por mais de 1 h | `⚠ Kiro: token expirado` |
| 5 | Usar o kiro-cli (ex.: uma mensagem no `kiro-cli chat`), depois **Reload Credentials** | volta a `✓` (hipótese a confirmar: o kiro-cli renova ao ser usado) |
| 6 | Conferir que a extensão não mexe no kiro-cli | listar o diretório do banco antes/depois: nenhum arquivo novo; `kiro-cli` continua logado |
| 7 | Settings: `kirorelay.auth.sources = ["sso-cache"]` | só a fonte JSON é usada |
| 8 | Settings: `kirorelay.auth.databasePath` apontando para outro caminho | o diagnóstico mostra o novo candidato |

### Se algo falhar

- **`node:sqlite: INDISPONÍVEL`** no diagnóstico: o Node embutido na sua versão do VS Code não
  tem o módulo. Me envie o relatório, o plano é adicionar o fallback com `sql.js`.
- **Banco não encontrado**: ajuste `kirorelay.auth.databasePath` e rode o diagnóstico de novo.
- Mais detalhes: `Developer: Toggle Developer Tools` (aba Console) e `Developer: Show Running Extensions`.

## Estrutura

```
src/
  extension.ts          # comandos, status bar (única parte que importa 'vscode')
  auth/
    credentials.ts      # parsing tolerante (snake_case/camelCase, timestamps com nanos)
    sqliteSnapshot.ts   # snapshot + node:sqlite
    kiroCliDb.ts        # fonte: banco do kiro-cli (+ inspeção p/ diagnóstico)
    ssoCache.ts         # fonte: ~/.aws/sso/cache/kiro-auth-token.json
    tokenProvider.ts    # provedor cooperativo (cache, releitura, single-flight)
    diagnose.ts         # relatório sem segredos
    factory.ts, paths.ts, errors.ts, redact.ts, source.ts
test/                   # node:test, rodam sem VS Code
```

## Próximas etapas

1. Validar o diagnóstico na sua máquina e ajustar caminhos/chaves.
2. Spike do cliente `@aws/codewhisperer-streaming-client` (endpoint, headers, campos).
3. Catálogo de modelos + `provideLanguageModelChatInformation`.
4. Chat só com texto (streaming), depois tools, imagens e esforço de raciocínio.
