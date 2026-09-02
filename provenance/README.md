
# Source snapshot

`donor.json` is the mechanical source/provenance manifest for the fork. The donor source, original tests, package metadata, notice ledger, and all gitlinks moved together to `packages/tui`. The active `upstream` remote must remain the donor URL. Provisioning logic refuses a pre-existing repository whose origin/upstream identity does not match this manifest; it never overwrites the collision.

A normal fresh clone has `origin` but may not have an `upstream` remote. `node scripts/check-repository-target.mjs --repo PATH --origin https://github.com/stokd-cloud/agent.git --upstream https://github.com/ccch1mneyyy/dsh-TUI.git --bootstrap-upstream` first verifies the exact origin and then idempotently adds the missing upstream. It refuses conflicting origins, conflicting upstreams, and non-Git paths before writing.
