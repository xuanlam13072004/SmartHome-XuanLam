/**
 * Which proxies may tell the Gateway the client's address (X-Forwarded-For).
 *
 * Through Cloudflare Tunnel every request reaches the Gateway from cloudflared,
 * so without this every user would share one address and the per-address
 * limits (sign-up, sign-in) would block everyone at once. Cloudflare appends
 * the visitor's address to X-Forwarded-For; trusting only loopback and private
 * sources makes that public address `request.ip`.
 *
 * Safe only while nobody else can reach the Gateway's port: docker-compose
 * publishes it on 127.0.0.1 (PUBLISH_HOST). Opening it to the LAN means
 * clearing TRUST_PROXY, or anyone on the LAN could claim any address.
 *
 * Value: comma-separated addresses, CIDRs or the presets `loopback`,
 * `linklocal`, `uniquelocal`; empty trusts nobody.
 */
export function trustProxyOption(value: string): string[] | false {
    const entries = value.split(',').map(item => item.trim()).filter(Boolean);
    return entries.length > 0 ? entries : false;
}
