# Verifying Product Control Plane webhooks

Each webhook notification is an HTTPS `POST` with a JSON body and this header:

```text
X-PCP-Signature: t=1792740000,v1=5f2b…
```

- `t` is the Unix time in seconds when the request was signed.
- `v1` is the lowercase hex HMAC-SHA256 of the string `"<t>.<raw request body>"`. The key is the channel's signing secret, which is shown once when the channel is created.

## To verify a request

1. Read the raw body as bytes. Do not parse and re-serialize the JSON first.
2. Split the header on `,` and read `t` and `v1`.
3. Reject the request when `t` is more than 300 seconds away from your clock (replay protection).
4. Compute `HMAC-SHA256(secret, t + "." + body)`, encode it as hex, and compare it to `v1` in constant time.

### Node.js

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyPcpSignature(secret, rawBody, header, now = Math.floor(Date.now() / 1000)) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  if (!t || !v1 || Math.abs(now - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

### Python

```python
import hashlib, hmac, time

def verify_pcp_signature(secret: str, raw_body: bytes, header: str, now=None) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1 or abs((now or int(time.time())) - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)
```

## Bodies

| `type` | When | Fields |
|---|---|---|
| `incident.opened` | An incident opens or reopens. The 30-minute cooldown applies. | `incident` (`id`, `title`, `severity`, `status`, `summary`, `startedAt`), `link` |
| `incident.escalated` | A critical incident is still unacknowledged after 15 minutes. | Same as `incident.opened` |
| `incident.resolved` | The condition cleared, or someone resolved the incident. | Same as `incident.opened` |
| `test` | Someone pressed **Test** on the channel. | `link` |

Answer with any 2xx status within 10 seconds. A failed delivery is retried up to 5 times with exponential backoff. After 3 deliveries in a row fail completely, the channel is marked **broken** until a test succeeds.
