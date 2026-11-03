# Outbound network policy

Automaton keeps access to public websites, configured Conway services and explicitly configured local inference backends. It does not apply a blanket ban to local/private services: that would break legitimate Ollama and self-hosted deployments.

## Two destination trust classes

- **Configured endpoint**: a backend selected by the operator. `ResilientHttpClient` keeps this mode by default. HTTPS is required; loopback HTTP is available only when the client explicitly enables it. IPv6 loopback works with that exception. URL user information is rejected: supply credentials in headers instead.
- **Public URL**: a URL supplied by an agent, web page, card or other remote input. Use `request(url, { networkPolicy: "public" })` or `fetchWithPolicy(url, init, { publicOnly: true })`. The policy checks literal and resolved IPv4/IPv6 addresses before every request and redirect; any private/reserved DNS answer rejects the target. Discovery always uses this mode, including the resolved IPFS gateway URL.

Do not promote an arbitrary tool URL to a configured endpoint. The distinction belongs to the trusted caller, not a model-supplied argument.

## Redirects, credentials and response limits

Requests use `redirect: "manual"`. Configured endpoints accept same-origin redirects by default. Public fetches may follow public GET/HEAD redirects, after validation; caller custom headers are stripped when changing origin. Authentication, cookie, API-key and payment headers must not cross origins. Signed/payment requests cannot redirect at all. Callers can explicitly choose `redirectPolicy: "none"`.

Response bodies are read incrementally under a byte ceiling, including chunked/decompressed responses without a Content-Length. The default HTTP ceiling is 8 MiB; callers may set `maxResponseBytes` for a documented larger response. Agent cards retain their smaller configured ceiling. The request deadline covers DNS checks, redirects, response headers and body consumption. Abort signals from the caller are forwarded.

These clients buffer bounded responses and are intended for existing non-streaming Conway API requests. A future streaming API should use a separate bounded streaming interface rather than disabling the limits here.

## DNS rebinding and proxies: remaining boundary

The DNS checks are preflight checks, **not socket-address pinning**. Native fetch and an inherited HTTP proxy may resolve the name again. Therefore the code does not claim protection against DNS changes between validation and connection. A controlled egress proxy/firewall must reject reserved/private destinations at connection time, including cloud metadata, and recheck redirects/DNS independently. Do not disable or bypass an inherited proxy to make a request succeed.

Configured backend access also remains a trust decision: a trusted local backend can intentionally be reached by the application, and this helper does not turn an unrestricted host shell into a network sandbox. Network isolation of agent-executed programs is a separate requirement.

## Validation

`pnpm test src/__tests__/network-policy.test.ts src/__tests__/http-client.test.ts src/__tests__/discovery-data-uri.test.ts src/__tests__/data-layer.test.ts --maxWorkers=2 --minWorkers=1`

The tests use mocked DNS and fetch streams, without contacting private services. They cover public access, reserved IPv6/mapped addresses, mixed DNS answers, redirect validation, credential protection, size limits, stalled bodies and explicit Ollama access.
