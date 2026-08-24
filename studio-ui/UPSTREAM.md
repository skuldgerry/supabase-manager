# Studio UI source

This directory vendors the Supabase Studio Multi-Head source used as the
pixel-for-pixel UI baseline for Supabase Manager.

- Source: https://github.com/flamingrubberduck/supabase-studio-multi-head
- Imported commit: `f88e4b4e6ba2f331ab1b2466cf7d120aaf9d47a2`
- Imported branch: `master`
- Import date: 2026-08-24

The original `LICENSE` file is retained in this directory. Multi-Head additions
and upstream Supabase Studio code remain governed by the terms described there.

During the UI-first phase, this source is kept structurally intact so that
Studio workspace packages, pages, styles, and Docker build behavior remain
identical to the reference deployment. The existing Supabase Manager broker
continues to live at the repository root and will replace Multi-Head's project
registry and orchestrator only after visual parity is established.
