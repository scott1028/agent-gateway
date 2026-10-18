# AGENTS.md — agent-gateway rules

## The big rule: copy how the official tool behaves

This project is a little helper (a "proxy"). It lets other programs use
your ChatGPT account to talk to the Codex brain behind the scenes.

Here is the thing to understand: the door it knocks on
(`https://chatgpt.com/backend-api/codex/*`) is a **back door**. It is not
a public shop window. It only expects one visitor: the official Codex
CLI. If our proxy knocks in a weird way — wrong words, wrong rhythm,
extra questions — the guard may think something is wrong and **ban your
account**.

So the rule is simple:

- **MUST** make our proxy behave exactly like the official tool does.
- The official tool's real source code lives in `./references/` (kept in
  sync with git submodules):
  - `references/codex/` → the official Codex CLI from OpenAI. This is
    the main copybook.
  - `references/claude-code/` → the official Claude Code from Anthropic.
    A second example of how a good client behaves.
- **MUST NOT** guess what the back door likes or invent new fields. If
  the official code does not do it, we probably should not either. The
  live checks in `scripts/poc.ts` are only a helper to confirm.
- We are matching *manners*, not wearing a mask. Our proxy still says
  its own name (`agent-gateway`) in the User-Agent. We act normal, we do
  not pretend to be someone else.

## Keeping `references/` fresh

- The copies in `references/` are pinned to exact versions (check with
  `git submodule status`). When you compare behavior, **MUST** write
  down which version you compared against.
- To download the copies: `make sync-submodule`.
- After updating them, **MUST** run `npm test`. If tests break, it means
  the official tool changed its manners. **MUST** fix our code to match
  the new manners — never bend the tests to fit old habits.

## How to change behavior

1. First, look inside `./references/` and find how the official code
   does it. (Tip: `grep` for the header name, the field name, or the
   exact word you care about.)
2. Our code in `src/` **MUST** do the same. When you copy a rule or a
   number from the official code, leave a short English comment naming
   the folder you copied it from, like:
   `// Mirrors references/codex/codex-rs/login/ refresh skew.`
3. If we truly must differ (the back door refuses something, or a
   client needs it), **MUST**:
   - keep the difference as small as possible;
   - write down *why* in `docs/` or the README, with proof from a real
     run (like `npm run poc` output).
   - User-approved exception, relay paths: some routes only pass along
     a request the official tool built by itself (`POST /v1/messages`
     and its `count_tokens` from the official Claude Code, and Codex's
     `/backend-api/codex/*` for both HTTP and WebSocket). There we forward the client's own
     User-Agent and other headers unchanged instead of saying
     `agent-gateway`, because the client already *is* the official
     tool. We only swap the token.
   - User-approved exception, downgrade path: `POST /v1/messages` from
     any other Anthropic client is rebuilt with the gateway's existing
     official assembly (the one `/v1/responses` uses) and sent with
     the gateway's own headers and pinned User-Agent. Only the request
     shape is official; the tools, system texts and messages stay the
     client's, so we **MUST NOT** claim the official client built it.

## Identity rules for relay fallback

- With `--relay-fallback=degrade`, an official relay request that fails the supported
  account/shape checks is gateway-built, like 2b: it MUST use the gateway's own headers,
  pinned User-Agent, with the target home's token. Claude Messages uses gateway `cch`
  and account metadata; count_tokens MUST use the native count-only body, without
  system, billing or metadata.
  It MUST NOT be described as a request built by the official client. Default `reject`
  keeps the existing relay behavior unchanged.
- User-approved relay exception: degraded Codex endpoints other than `POST /responses`
  (for example `GET /models`) still forward the client's own request and User-Agent,
  replacing only the token and `chatgpt-account-id` (plus normal hop framing/host).
  This is the same client-built relay exception described above, not gateway impersonation.

## Similarity check after upstream API changes

- When you finish adjusting upstream API code (request shaping, headers,
  auth/refresh, streaming), **MUST** run one extra evaluation: compare
  the changed behavior against the real agent CLI tools vendored under
  `references/**/`.
- **MUST NOT** guess or trust earlier notes: re-open the pinned copy in
  `references/` and check the exact code path (grep the header, field,
  or flow), and write down which version you compared against.
- **MUST** report to the user how similar the simulation currently is,
  in plain terms: which behaviors match the official CLI exactly,
  which are documented deviations, and which are still unverified.
  That way the user always knows the current similarity level.

## Tests must prove we match

Every behavior we copied from the official code **MUST** have a test
(vitest; the `test/` folder mirrors `src/`):

- Constants and headers we took from the official code (their names,
  their values, and *when* they appear) **MUST** have assertion tests.
  For example: the `originator` name, the OAuth client id, the "lite"
  header, and the account-id header only showing up when there is an
  account id.
- Every test file **MUST** say, in an English comment, which official
  folder it is matching. That way, when the official code updates, we
  can find what to re-check.
- Request cleanup rules (dropping fields not on the allowlist,
  `system` → `developer`, `ultra` → `max`, the lite "functions"
  wrapper, `parallel_tool_calls:false`) **MUST** have unit tests.
- Reading the streaming replies (SSE) **MUST** be tested with saved
  sample files in `test/fixtures/*.sse`.
- Prefer plain function tests over component/integration tests; fake
  the upstream with mock responses.

## Before saying "done"

All of these **MUST** pass:

```bash
npm run typecheck
npm test
```

`npm run poc` really calls the back door and spends your account quota,
so it **MUST NOT** run as part of normal tests. Run it by hand only
after changing upstream behavior, to re-confirm what the back door
actually accepts.
