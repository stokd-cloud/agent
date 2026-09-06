---
name: aws-cost-analysis
description: >
  Exhaustive multi-profile AWS cost analysis with actionable waste/sizing/commitment
  findings and looking-forward trend forecasts from scheduled snapshots. Use when the
  user runs /aws-cost-analysis, /cost-analysis, asks to configure cloud cost review,
  run a cost analysis, AWS burn review, FinOps report, schedule cost snapshots, or
  forecast run-rate from prior cost reports. Also matches "how much am I spending on
  AWS", "credit runway", and "budget breach horizon".
---

# AWS Cost Analysis (multi-profile)

Read-only AWS investigation by default. **Never** terminate resources, buy commitments, or change infra unless the user explicitly asks for a separate mutating task.

Toolkit lives next to this skill:

```
~/.stokd/skills/aws-cost-analysis/scripts/cost_analysis.py
```

Config + history:

```
~/.stokd/cost-analysis/config.json
~/.stokd/cost-analysis/snapshots/<profile>/*.json
~/.stokd/cost-analysis/reports/<profile>/*.md
```

If the script is missing, re-run `stokd skill install` / `stokd install` (bundled skills) or copy from the stokd CLI templates.

---

## Entry points (map user intent)

| User intent | Action |
|-------------|--------|
| configure / setup / which profiles | **Configure** |
| run / review / analyze / burn report | **Run** |
| schedule / recurring / launchd | **Configure** (schedule section) or re-open configure |
| forecast / trends / runway / breach horizon | **Run** (auto-includes trends when ≥ N snapshots) or `trends` only |
| status / show config | `python3 …/cost_analysis.py status` |

Default N for looking-forward artifacts: **`forecast_min_snapshots = 4`** (configurable).

---

## Phase A — Configure (one command flow)

Trigger: `/aws-cost-analysis configure` or “set up cost analysis”.

1. **List machine profiles** (do not invent):
   ```bash
   python3 ~/.stokd/skills/aws-cost-analysis/scripts/cost_analysis.py list-profiles
   ```
   Fallback: `aws configure list-profiles`.

2. **Multi-select UI** — use `ask_user_question` (or equivalent multi-select) with:
   - One option per AWS profile found
   - Recommended: profiles that successfully resolve `sts get-caller-identity`
   - Allow selecting **multiple** profiles
   - Option: “Done / finish configuration” when they are finished toggling

3. For **each selected profile**, ask (batch when possible):
   - Enable analysis? (yes)
   - Recurring schedule: `none` | `daily` | `weekly` (default `weekly` if they want recurring)
   - Optional monthly budget USD (for breach-horizon)
   - Optional quarterly budget USD
   - Display label (default = profile name)

4. **Forecast depth**:
   - `forecast_min_snapshots` (default **4**) — min scheduled/manual snapshots before full looking-forward suite is considered “complete”

5. **Persist**:
   ```bash
   python3 ~/.stokd/skills/aws-cost-analysis/scripts/cost_analysis.py configure \
     --set-json '<json>'   # or interactive flags from script --help
   ```
   Prefer building JSON and calling:
   ```bash
   python3 …/cost_analysis.py configure --from-file /tmp/cost-analysis-config.json
   ```

6. **Schedules** — for each profile with `schedule` ≠ `none`:
   ```bash
   python3 …/cost_analysis.py schedule-install --profile <name>
   ```
   macOS: user LaunchAgent under `~/Library/LaunchAgents/cloud.stokd.cost-analysis.<profile>.plist`.  
   Linux: print cron line if launchd unavailable.  
   Never install system-wide daemons.

7. Confirm with `status` and stop. Do **not** run a full analysis unless the user also asked to run.

### Configure UX rules

- Always show account id + ARN alias after identity check per profile.
- Profiles that fail STS: include in list as **(unreachable)** — still selectable but warn.
- User says **Done** → write config, install/remove schedules to match, summarize, exit configure.

---

## Phase B — Run (exhaustive review)

Trigger: `/aws-cost-analysis run` or “run cost analysis”.

1. Load config. If missing, offer configure first (or run all reachable profiles once with defaults, then prompt to save).

2. Resolve target profiles:
   - Explicit profile args from user, else all `enabled` in config, else all STS-reachable profiles.

3. For each profile (sequentially; do not thrash rate limits):
   ```bash
   python3 ~/.stokd/skills/aws-cost-analysis/scripts/cost_analysis.py run \
     --profile <name> \
     --lookback-days 30
   ```
   Capture stdout path to report + snapshot.

4. **Synthesize for the human** (do not dump raw JSON):
   - Gross usage vs credits vs support (never claim “$0 bill” without separating Usage vs Credit)
   - Top services (Usage only)
   - Daily burn + monthly pace
   - Credit remaining if discoverable from prior notes / CE only shows applied credits
   - **Actionable sections** below (map script findings → recommendations)
   - If snapshot count ≥ `forecast_min_snapshots`, include **Looking forward** section

5. Link report paths under `~/.stokd/cost-analysis/reports/`.

### Actionable output map (must cover when data exists)

Use the categories from the product spec. Every finding needs **what / evidence / suggested action / rough $ impact** when estimable.

#### 1. Direct waste elimination (immediate ROI)

- Unattached EBS, unassociated EIPs, idle ALBs/NLBs (0 healthy targets / 0 running tasks), old snapshots
- Idle EC2 (<5% CPU 14–30d when metrics exist)
- Non-prod 24/7 signals (name/tag contains stage/dev/test + always-on cost)
- Legacy instance families (m4/c4/r4 etc.) vs modern/Graviton note

#### 2. Capacity & sizing

- Rightsizing hints from CloudWatch when available
- ElastiCache / RDS / oversized single-tenant always-on
- S3 / EBS growth and lifecycle absence
- Lambda high memory + low duration

#### 3. Rate & commitment

- Savings Plans / RI coverage gaps (CE or `ce get-savings-plans-utilization` when permitted)
- SP/RI expiration windows
- Underutilized commitments
- Spot-eligible patterns (batch/CI naming) — recommendation only

#### 4. Operational & architecture governance

- Data transfer / NAT Gateway / cross-AZ lines as first-class cost
- Tagging coverage % (if cost allocation tags exist; else note “no active cost allocation tags”)
- Anomaly vs prior snapshot or WoW spike
- Log retention bloat (CloudWatch log groups >> GB)

#### 5. Strategic / unit economics (best-effort)

- COGS-ish vs R&D-ish split by name heuristics (prod vs stage/dev) when tags missing
- Per-service share of total
- Only invent unit costs (per user/API call) if user configured denominators in config

### Safety

- Read-only AWS APIs only in this skill path.
- Prefer `AWS_PROFILE=<p> AWS_DEFAULT_PROFILE=<p>` explicit per call.
- If unsure which account — stop and ask (never use a silent default prod profile for destructive anything; this skill is non-destructive anyway).

---

## Phase C — Looking forward (N snapshots)

Requires **N ≥ `forecast_min_snapshots`** (default 4) completed runs for that profile (scheduled or manual).  
Force with:

```bash
python3 …/cost_analysis.py trends --profile <name> --min-snapshots 4
```

### 1. Run-rate & trend artifacts

- **Monthly/Annual run-rate forecast** from latest window slope → 12-month horizon
- **Cost acceleration (velocity)**: WoW or snapshot-to-snapshot Δ, then Δ-of-Δ per service
- **Baseline vs variable trajectory**: fixed-ish services (ELB, VPC/NAT, ElastiCache, ECS steady, R53, WAF, Secrets) vs variable (Lambda, API GW, Bedrock, data transfer spikes, CloudWatch ingest)

### 2. Resource-level projections

- **Storage growth compounding**: EBS/S3-related usage lines regression → projected spend; flag if growth rate implies doubling window
- **Commitment decay**: if coverage % available across snapshots, project effective discount erosion
- **Egress / data transfer projections** from CE data-transfer lines

### 3. Threshold & anomaly (trend breakers)

- **Budget breach horizon**: calendar date monthly/quarterly budget is crossed at current slope (needs budget in config)
- **Statistical banding**: P10 / P50 / P90 on recent totals when ≥ N points
- **Category drift**: service share % movement across snapshots (e.g. compute 60%→40%)

If N is insufficient, report: `have X of N snapshots — looking-forward suite deferred` and still show single-run analysis.

---

## Phase D — Schedule maintenance

```bash
python3 …/cost_analysis.py schedule-install --profile <p>
python3 …/cost_analysis.py schedule-remove --profile <p>
python3 …/cost_analysis.py schedule-list
```

Scheduled job must invoke:

```bash
python3 ~/.stokd/skills/aws-cost-analysis/scripts/cost_analysis.py run --profile <p> --scheduled
```

Logs: `~/.stokd/cost-analysis/logs/<profile>.log`

---

## Agent presentation rules

1. Lead with **gross burn** and **action list**, not CE’s net-zero-after-credits illusion.
2. Separate **Usage / Credit / Support / Tax**.
3. Rank actions by **$/effort** (waste first, then NAT/ALB floor, then commitments).
4. Cite snapshot timestamps and profile → account id.
5. Keep the human reply tight; put depth in the markdown report file.
6. Multi-account: one section per profile, then a cross-account rollup if ≥2.

---

## Quick commands cheat sheet

```bash
SCRIPT=~/.stokd/skills/aws-cost-analysis/scripts/cost_analysis.py

python3 "$SCRIPT" list-profiles
python3 "$SCRIPT" status
python3 "$SCRIPT" configure --from-file ./config.json
python3 "$SCRIPT" run --profile stokd-cloud
python3 "$SCRIPT" run --all-enabled
python3 "$SCRIPT" trends --profile stokd-cloud
python3 "$SCRIPT" schedule-install --profile stokd-cloud
python3 "$SCRIPT" schedule-list
```
