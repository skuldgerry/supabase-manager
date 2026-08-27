Supabase Manager V1 is the first stable release of the local-first control plane for isolated official Supabase self-hosted deployments.

Highlights:

- one manager login with optional TOTP 2FA, organizations, and project switching;
- official Supabase release selection with version-compatible Envoy or Kong adapters;
- per-project ports, generated or customized secrets, encrypted credential retrieval, and AI provider settings;
- durable provisioning and update progress with sanitized diagnostics;
- same-host import for existing official Compose deployments;
- broker-managed project deletion, including containers, networks, named volumes, configuration, and credentials;
- a two-container control plane where only the broker receives the Docker socket.

The manager does not proxy project traffic. Each project exposes its own selected API and database pooler ports. Imported projects remain externally owned and are never deleted by the manager.

Use the pinned `1.0.0` and `1.0.0-broker` images from the Compose example in the README.
