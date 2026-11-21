# pg-meta connection encryption

Manager projects use the broker's private proxy to reach their own pg-meta.
Older manually connected projects can instead send an encrypted connection
string to a shared pg-meta using the `x-connection-encrypted` header.

The official pg-meta decrypts that header with CryptoJS AES and its `CRYPTO_KEY`.
Studio uses the same value as `PG_META_CRYPTO_KEY`. The reversible, salted
OpenSSL-compatible format is an upstream protocol requirement, not a password
hash. Replacing it with bcrypt, Argon2, or a different encryption envelope would
break an unchanged official pg-meta service.

In production, encrypted connections reject missing keys, `SAMPLE_KEY`, and
the example `your-encryption-key-32-chars-min`. Set a private, randomly generated
key on Studio and the matching key on pg-meta before using those connections.
Supabase recommends at least 32 characters and provides this generation command:

```sh
openssl rand -base64 24
```

Keep the generated value private. Set it as `PG_META_CRYPTO_KEY` on Studio and
`CRYPTO_KEY` on pg-meta, then recreate both services with the matching values.
The official Compose stack already maps these settings from the same variable.
Manager does not change or rotate an imported stack's key automatically.

Existing non-default custom keys keep their exact value for compatibility,
including older short keys. Length alone cannot establish randomness: plan a
coordinated change to a random key for installations that use a guessable key.
Local development retains the official CLI's `SAMPLE_KEY` convention; it must
not be used for production. Normal Manager projects do not need a global
Studio pg-meta key because their connections go through the broker.

Keep pg-meta on a trusted private network, as required by its upstream design.
The legacy envelope does not provide the integrity guarantees of a modern
authenticated encryption protocol. Its format cannot be strengthened on just
the Studio side while retaining compatibility with the official receiver.

Upstream references:

- [Official pg-meta receiver](https://github.com/supabase/postgres-meta/blob/v0.100.0/src/server/routes/index.ts)
- [Official Studio sender](https://github.com/supabase/supabase/blob/self-hosted/v0.8.3/apps/studio/lib/api/self-hosted/util.ts)
- [Official self-hosted key configuration](https://github.com/supabase/supabase/blob/self-hosted/v0.8.3/docker/.env.example)
