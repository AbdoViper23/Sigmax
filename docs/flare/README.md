# Sigmax on Flare — Documentation

This folder holds the **current (Flare) project docs**. The numbered docs under `../` (`docs/00…94`)
are **Story-era historical docs**, superseded by this folder and the design spec.

## Start here
- **Design spec (source of truth):** [`../superpowers/specs/2026-07-23-sigmax-on-flare-design.md`](../superpowers/specs/2026-07-23-sigmax-on-flare-design.md)
  — architecture, invariants, repo layout, and the phase-by-phase build plan with acceptance tests.

## Reference
- [`00-product-brief.md`](00-product-brief.md) — product vision + hackathon context (Flare Summer Signal).
- [`01-technical-blueprint.md`](01-technical-blueprint.md) — verified Flare component availability, APIs, addresses, risk table.
- [`reference/existing-codebase-map.md`](reference/existing-codebase-map.md) — map of the pre-existing code we build on (contracts, agent, CDR, frontend). Precedence: **live code > README > docs/**.
- [`reference/flare-llms.txt`](reference/flare-llms.txt) — Flare developer-docs index (`llms.txt`).

## Bounties
- **Bounty 2 — Confidential Compute Apps** (primary): the FCC extension that decrypts and executes inside a TEE.
- **Bounty 1 — Interoperable Asset Products** (secondary): FXRP as the traded/subscription asset + FTSO price bounds.
