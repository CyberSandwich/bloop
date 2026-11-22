# ADR 0004: token vault and key rotation

Status: proposed. It implements ADR 0001's token-protection row.

## Context
With `offline_access`, bloop holds a Microsoft refresh token per user that can read the whole OneDrive (`Files.Read`). This is the first DPIA item: one breach exposes every connected drive. Microsoft rotates refresh tokens on every use, keeps them 90 days by default, and binds a confidential client's tokens to that client's credential.

## Decision
- **Confidential client:** `oauth4webapi`, authorization code with PKCE S256, `state` and `nonce`, against `ENTRA_AUTHORITY` (`organizations`).
  - Client authentication starts with `ENTRA_CLIENT_SECRET`; `private_key_jwt` is the upgrade.
  - The issuer check substitutes `tid`, and users are keyed by `(tid, oid)`.
- **Envelope encryption with Web Crypto:**
  - Each user gets a random 256-bit data key (DEK), wrapped with AES-KW by the current KEK (`TOKEN_KEKS[TOKEN_KEK_CURRENT]`), stored in `token_grant.dek_wrapped` with its `kid`.
  - The refresh token and the cached access token are encrypted with AES-256-GCM under the DEK, with a random 96-bit IV, and AAD `user_id|version|field`, so a row moved to another user fails to decrypt.
- **Refresh:** decrypt, call the token endpoint, encrypt the new pair, then `UPDATE ... SET version = version + 1 WHERE user_id = ? AND version = ?`. The loser of a race re-reads and uses the winner's access token.
- **Access tokens** are cached encrypted for at most their `exp` (about 1 h), and are never sent to a client or logged.
- **KEK rotation:**
  1. Add the new key to `TOKEN_KEKS` and point `TOKEN_KEK_CURRENT` at it.
  2. Every use re-wraps the DEK under the current KEK; the daily cron re-wraps the rest.
  3. When `SELECT count(*) FROM token_grant WHERE kid != current` is 0, delete the old key.
- **Limits on what is held:** a grant unused for `GRANT_IDLE_DAYS` (30) is deleted. Disconnect and erasure delete it at once.
- **Breach plan:**
  1. Rotate the Entra client secret, which strands every stolen refresh token.
  2. Delete all grants.
  3. Rotate the KEK, cookie key and pepper.
  4. Notify, according to the legal lane's tiers.
- **`TOKEN_MODE=session`** (owner option, OD-1): drop `offline_access`, keep only the access token, encrypted, for the session's life, and send the phone through a Microsoft redirect at each session start (often silent if Microsoft's own sign-in cookie is still there).

## Consequences
- A leak of D1 alone yields ciphertext. A leak of D1 plus the KEK still needs the client secret to redeem tokens. A compromise of the whole Cloudflare account, or a malicious deploy, defeats all three: an external KMS or HSM is the only upgrade that defends that, at a cost ADR 0001 rejects for the MVP.
- In `session` mode the DPIA item mostly disappears. The cost is a redirect at each start and the "sign in once" promise.
- The claim "a stolen refresh token is useless without the client secret" must be verified on the demo tenant (F-ENTRA).
