# Company Customizations

Distribution: `zad-zbs-fiza`

Status: Production

Maintained repository: `ai-devops/innovation/llm-gateway/omniroute`

GitHub development fork: `azox-ai/azox-omniroute`

Upstream: `diegosouzapw/OmniRoute`

Upstream baseline: `release/v3.8.51` at
`949235736042b13cf64215632e6d44db7985af76`

## Policy

This repository carries only changes required by the company deployment while
their upstream pull requests remain open. Every customization must:

1. include focused tests;
2. be proposed upstream when generally useful;
3. record its upstream issue and pull request here;
4. be removed from the patch set after an upstream release contains it;
5. preserve `LICENSE` and `THIRD_PARTY_NOTICES.md`.

Production credentials, OAuth state, API keys, SQLite databases, backups and
environment files must never be committed to this repository.

## Active Customizations

### Cloudflare managed challenge is non-terminal

Files:

- `open-sse/services/errorClassifier.ts`
- `tests/unit/error-classifier.test.ts`

Problem: OpenAI's Cloudflare edge can return a managed challenge on a healthy
Codex OAuth connection. OmniRoute previously classified the unmatched HTTP
`403` as `FORBIDDEN` and persisted `testStatus=banned`, `isActive=false`.

Fix: recognize full Cloudflare interstitial markers (`_cf_chl_opt`,
`cdn-cgi/challenge-platform`, and `challenge-error-text`) as
`FINGERPRINT_REJECTION`. OmniRoute already treats that error type as
non-terminal, so the provider account remains active.

References:

- GitHub fork PR: `azox-ai/azox-omniroute#1`
- Upstream issue: `diegosouzapw/OmniRoute#13157`
- Upstream PR: `diegosouzapw/OmniRoute#13161`

Verification: error-classifier tests `39/39`, auth-terminal-status tests
`11/11`, TypeScript typecheck and ESLint passed.

### Count Responses input tokens locally

Files:

- `src/app/api/v1/responses/input_tokens/route.ts`
- `tests/unit/responses-input-tokens-local-route.test.ts`

Problem: the ChatGPT subscription backend does not serve
`/backend-api/codex/responses/input_tokens` for the affected Codex OAuth
account. Native requests are intercepted by a Cloudflare managed challenge;
the same request through the Chrome transport returns `404 Not Found`.

Fix: a static `/v1/responses/input_tokens` route shadows the generic Responses
passthrough and counts locally with the existing Codex `o200k_base` tokenizer.
It preserves API-key/model policy and body admission, returns the standard
`response.input_tokens` contract, and makes no upstream request.

References:

- GitHub fork PR: `azox-ai/azox-omniroute#2`
- Upstream PR: `diegosouzapw/OmniRoute#13167`

Verification:

- route unit tests `9/9`, TypeScript typecheck and ESLint passed;
- production A/B: eight request shapes, zero under-counts, median absolute
  error `0%` against real Codex `usage.input_tokens`;
- production soak: `50/50` plus isolated `100/100` HTTP `200`;
- isolated soak: zero outbound proxy-log rows, zero Cloudflare challenges and
  zero permanent-disable events.

## Production Reference

Source commit before this distribution metadata commit:
`90a3afaaa74fe01df71389918573a32f74046848`.

Verified production image:
`llm-gateway/omniroute:3.8.51-113ddf9a-azox1`.

Verified image ID:
`sha256:db68526af9d60897aaf96cc0ca7f4486b566d299265f5d9d84614a3a31f40b19`.

## Internal Tags

All internal release tags must begin with `zad-zbs-fiza-`.

Format:

```text
zad-zbs-fiza-v<upstream-version>.<internal-revision>
```

Example:

```text
zad-zbs-fiza-v3.8.51.1
```

