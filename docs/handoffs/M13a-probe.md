# Handoff — M13a Website probe and domain verification

| | |
|---|---|
| **Status** | Done |
| **Date** | 2026-10-23 |
| **Branch** | `feat/m13a-websites` |
| **Plan** | M13a plan Task 2 |
| **Workbooks** | WB-09 UC-09-01, UC-09-03, §8 |

## Delivered (`packages/website-probe`)

- **`probe(url, {destination, now, timeoutMs=10s, maxRedirects=10, expectedStatus, ca})`.**
  - **SSRF:** each hop is resolved once with `assertPublicDestination` and requested through an undici agent pinned to that address, so redirects to private or link-local addresses are blocked.
  - **TLS:** expiry and issuer are read with a separate handshake to the vetted address. They are reported even when the request fails, for example on an untrusted certificate.
  - **Recorded:** status, final URL, redirect count, TTFB, and total time. The body read is capped at 64 KB.
  - **Up** means the expected status, or any 2xx/3xx when none is set, with no challenge page.
  - **Challenge pages:** `cf-mitigated: challenge`, or a "Just a moment" or `challenge-platform` body on 403/503, is flagged as `challenge` with a hint to allowlist the probe user agent.
  - **Failures:** more than 10 redirects is reported as a loop. Timeouts and network or TLS errors are reported with their reason.
- **`verifyDomain(host, token, resolveTxt)`.**
  - Looks for the TXT record `pcp-verify=<token>` on the host, then on each parent domain.
  - Stops before a single label or a known two-label public suffix such as `co.uk` or `com.pk`, so a record on `com` or `co.uk` proves nothing.

## Tests

`probe.test.ts` (8) uses local HTTP and HTTPS servers, the latter with a self-signed certificate from `openssl` that expires in 13 days. It covers:
- status, timing, and the TLS issuer and expiry
- a redirect chain, an unexpected status, and a custom expected status
- a loop stopped at 10 hops, and a redirect to `169.254.169.254` blocked
- a challenge page and a timeout
- a private target refused without an allowlist
- an untrusted certificate marking the site down
- verification on a parent domain, never on public suffixes or with a wrong token
