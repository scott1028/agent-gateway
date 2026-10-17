[繁體中文](README.md) | **English** | [日本語](README.ja.md)

# <img src="assets/icon.png" width="40" alt="" /> agent-gateway

![agent-gateway mascot: a receptionist with short mint-teal hair sits on a red-brick platform while layers of green pipes cross and merge in an underground hall of tall pillars](assets/banner.png)

agent-gateway is a small relay station that runs on your computer. It lets other AI tools borrow your signed-in ChatGPT (Codex) or Claude Code account.

Think of it as a universal plug adapter: your tool only speaks OpenAI's "language", and agent-gateway plugs it into your Codex or Claude account. On the tool side, just change the OpenAI `base_url` to `http://127.0.0.1:8765/v1`.

> This is unofficial use. It talks to an internal API that is not public, so it may change or be blocked at any time. Usage counts against your own ChatGPT/Claude plan. Check the OpenAI and Anthropic terms of use yourself before using it.

## Features

| Feature | In plain words |
|---|---|
| OpenAI compatible | Any tool that speaks the OpenAI format works once you change `base_url` |
| Two kinds of accounts | One gateway can serve a ChatGPT (Codex) login and a Claude Code subscription login at the same time |
| Three endpoints | `/v1/models`, `/v1/responses`, `/v1/chat/completions`, with streaming and tool calls |
| Multiple accounts | One home per account, auto-named `codex1`, `codex2`, `claude1`…; pick an account with a model prefix, e.g. `codex2/gpt-5.6-terra` |
| Follows the official rules | Request format, headers, and token refresh follow how the official CLIs do it; see "How close to official?" below |
| Local by default | Listens on `127.0.0.1` with no API key by default; to serve other machines, use `--host` with `AGENT_GATEWAY_API_KEY` (see "對外開放" in the [user guide](docs/GUIDE.md)) |
| Automatic token refresh | On a 401 it refreshes the token and retries once; Claude accounts share the official CLI's refresh lock, so they never fight over tokens |
| Resumable tool turns | Claude's thinking signatures are saved locally, so a tool turn can continue even after a gateway restart |
| Debug levels | `--debug 0`–`3` control how much detail is printed; tokens are never printed, prompts are printed as-is |
| Single executable | Executables for Linux, macOS, and Windows plus an AppImage, with Node.js built in; nothing else to install |

## How close to official?

Think of the official CLI as the "answer key", always worth 100 points. We treat each connection detail (URL, headers, login method…) as one question and check our answers: a match earns the point, a mismatch earns nothing, and questions we cannot verify yet are left out.

| Upstream | Who | Score (official = 100) | Compared version | Report |
|---|---|---:|---|---|
| Claude | Official Claude Code | **100** (baseline) | `references/claude-code` `9b4f0d6` + native 2.1.299 | [Claude similarity](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) |
| Claude | **agent-gateway** | **65** | `dfb0d6c` | Same as above |
| Claude | CLIProxyAPI | 42.78 | `references/CLIProxyAPI` v8.0.29 (`5fc580b`) | Same as above |
| Claude | EasyCLIProxyAPI | Not scored separately | Desktop wrapper; its connection core is CLIProxyAPI v8.0.29 | [EasyCLIProxyAPI comparison](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) |
| Codex | Official Codex CLI | **100** (baseline) | `references/codex` `0d58012` | [Codex protocol diff §4.1.1](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) |
| Codex | **agent-gateway** | **82.35** | `dfb0d6c` | Same as above |
| Codex | Unsloth | 35.29 | `references/unsloth` `1fdcdb5` | Same as above |

- Claude and Codex use different question sets: Claude has 30 questions in 6 groups; Codex only compares 17 endpoint/header rows. Do not compare scores across the two.
- The score only measures "does it connect like the official tool". It is not a quality score, and it does not guarantee the tool won't be recognized as unofficial.
- On the Codex path, the User-Agent deliberately carries our own name `agent-gateway`, so that question scores zero.
- Strictest Codex count: also include the 8 extra headers the official CLI sends only under certain conditions (neither side sends them). Then gateway scores 56 and Unsloth 24.
- Evaluated on 2026-10-17; the official Claude evidence reuses the records from native 2.1.299.

## Quick start

1. Download the executable for your platform from [GitHub Releases](https://github.com/scott1028/agent-gateway/releases), or use the source code (needs Node.js 22+).
2. Log in with the official CLI into a **dedicated** home. Don't use your everyday `~/.codex` directly, or the two will fight over tokens.
3. Start the gateway and tell it where the home is. The gateway has no default home.

```bash
# Codex (ChatGPT account)
mkdir -p ~/.agent-gateway && chmod 700 ~/.agent-gateway
CODEX_HOME=~/.agent-gateway codex login        # add --device-auth if there is no browser

./agent-gateway-<version>-linux-x64 --codex-home ~/.agent-gateway
# or from source: npm install && npm run build && npm start -- --codex-home ~/.agent-gateway
# agent-gateway listening on http://127.0.0.1:8765/v1
```

```bash
# Claude (Claude Code subscription account), can run alongside Codex
mkdir -p ~/.agent-gateway-claude && chmod 700 ~/.agent-gateway-claude
CLAUDE_CONFIG_DIR=~/.agent-gateway-claude claude     # type /login once inside

./agent-gateway-<version>-linux-x64 --codex-home ~/.agent-gateway --claude-home ~/.agent-gateway-claude
```

```bash
# Quick start: use every logged-in .codex, .codex-*, .claude, .claude-* under $HOME
./agent-gateway-<version>-linux-x64 --auto
#   codex1 -> /home/you/.codex
#   claude1 -> /home/you/.claude
```

`--auto` uses the homes your everyday `codex` CLI uses. While the gateway runs, do not run `codex` on the same home, or one side gets logged out. See "自動掃描 home（`--auto`）" in the [user guide](docs/GUIDE.md).

For checksum verification, first-run prompts on macOS/Windows, AppImage usage, environment variables, and every option, see the [user guide](docs/GUIDE.md) (in Chinese). Upgrading from the old codex-proxy? Read the migration steps in the guide first.

## Connect your tool

Without `AGENT_GATEWAY_API_KEY`, `apiKey` can be anything; the gateway does not check it. With it set, use the same key.

```js
// OpenAI SDK
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8765/v1', apiKey: 'unused' });
```

```bash
# aider
aider --model openai/codex1/gpt-5.6-terra --openai-api-base http://127.0.0.1:8765/v1 --openai-api-key unused

# Codex itself
codex exec -c 'model_providers.agent-gateway={ name = "agent-gateway", base_url = "http://127.0.0.1:8765/v1", wire_api = "responses" }' \
  -c model_provider=agent-gateway -m codex1/gpt-5.6-terra "your prompt"
```

## Things to watch out for

- Give each home to one gateway only, and don't run `codex` on it at the same time. A refresh token works only once, so simultaneous refreshes knock each other out.
- `previous_response_id` is handled inside the gateway: finished responses are kept in memory (up to 1000, lost on restart), and the id is expanded into the full input before the upstream call, so the upstream request is exactly the same as sending the whole conversation. Responses sent with `store:false` are not kept; `instructions` and `tools` are not carried over, so resend them every turn; continue with a model of the same account, and after the home logs in to another account, old ids can no longer be continued.
- Out of quota returns 429; a plan without Codex returns 403; if the token cannot be recovered, it returns 401 with the command to log in again.
- More limits and conversion rules are in the [user guide](docs/GUIDE.md).

## More docs

These documents are written in Traditional Chinese.

| Document | What's inside |
|---|---|
| [User guide](docs/GUIDE.md) | Full setup, environment variables, debug levels, multiple accounts, Claude details, conversion rules, known limits, migration |
| [Development and packaging](docs/DEVELOPMENT.md) | Local build and verification, AppImage, GitHub releases, project checks |
| [Claude similarity](docs/ANTHROPIC_CLAUDE_CODE_PROVIDER_SIMILARITY.md) | 30-item score with official Claude Code as the baseline |
| [Claude protocol diff](docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md) | Claude upstream headers, OAuth, SSE, and deviations |
| [EasyCLIProxyAPI comparison](docs/CLAUDE_EASYCLIPROXY_COMPARISON.md) | EasyCLIProxyAPI/CLIProxyAPI integration and credential review |
| [Codex protocol diff](docs/CODEX_UNSLOTH_PROTOCOL_DIFF.md) | Codex upstream compared with Unsloth and the official Codex CLI, plus similarity |
| [Codex WebSocket transport](docs/CODEX_WEBSOCKET_TRANSPORT.md) | The official default WebSocket incremental transport: not implemented in the gateway yet, with options and risks |
| [Mascot and icon](assets/README.md) | Image assets, ComfyUI workflows, and how to remake them |

## Development

```bash
npm run typecheck
npm test
```

`npm run poc` really calls the upstream and uses your quota; run it by hand only after changing upstream behavior. Details are in [Development and packaging](docs/DEVELOPMENT.md).
