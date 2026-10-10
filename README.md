# RugCheck local worker skill

RugCheck prepares a bounded evidence report for a public Solana mainnet mint. It starts a separate task-specific local Codex worker and routes its inference through our RugCheck gateway. The gateway collects public-chain evidence. Findings can be partial and do not guarantee token safety, future sellability, liquidity locks, or common ownership.

This is a public trial service. Default gateway: `https://rugcheck.r95426882.workers.dev/v1/rugcheck`; model: `deepseek-flash`. No installer API key or normal provider configuration change is required. The gateway is capped globally at 50 checks/day, 6 model requests/check, 2048 output tokens/request, 20 RPC/check and 120 seconds/check. Automatic increases are off. A fixed Worker URL forwards to a temporary tunnel origin, so an origin restart can interrupt service. Availability and complete evidence coverage are not promised.

## Installation

Requires Node 24, an installed Codex CLI and network access to the confirmed gateway. The package bundles its runtime and has no npm runtime dependencies, install hooks or Docker requirement. Installation alone runs no token analysis.

Install into a chosen project with:

```bash
npx skills add random-react-dev/rugcheck --skill rugcheck --agent codex --copy --yes
```

Resolve SKILL_DIR to the installed folder containing SKILL.md; in the standard project installation it is `.agents/skills/rugcheck`. Use an absolute Codex executable path, for example the result of `command -v codex`.

## Run a check

Ensure the user has authorized local worker execution and the gateway processing below. The installed skill uses the public gateway and model defaults above automatically. No per-user provider key is needed by this launcher. Do not paste a server key or change the user's normal Codex provider settings.

```bash
node SKILL_DIR/scripts/check-environment.mjs /absolute/path/to/codex
```

The prerequisite check runs only CLI help with a temporary home. It does not establish live gateway compatibility. Create a task file containing only:

```json
{"chain":"solana-mainnet-beta","mint":"So11111111111111111111111111111111111111112","profile":"core-cpmm-v1"}
```

Replace the example mint with the requested public address, then run:

```bash
node SKILL_DIR/scripts/run-agent3.mjs TASK.json https://rugcheck.r95426882.workers.dev/v1/rugcheck deepseek-flash /absolute/path/to/codex
```

On the first official pilot check, the launcher automatically creates and enrolls an Ed25519 installation identity at `~/.local/state/rugcheck/identity.pem`, then reuses it for foreground and background checks. The dedicated state directory is owner-only (0700) and the key file is owner-only (0600); unsafe files are rejected. No login, provider key, owner key or extra setup agent is required. Installation alone does not enroll or run a check.

The private installation key stays local. Only its public key and signed task requests go to the gateway; signatures bind the task body, route, timestamp and nonce. This identifies possession of the installation state, not a unique physical computer: copying the state clones the identity. Keep the key private. Custom gateways do not automatically enroll by default. Older anonymous clients still work but their history is unattributed.

The service records the installation identifier and task history for operation, troubleshooting and the owner dashboard. It does not remotely launch a worker, execute downloaded files or commands, or send provider secrets to clients. Owner control routes are outside this skill. Provider credentials and private service instructions stay server-side.

The supplied URL must use HTTPS, except loopback HTTP for explicitly authorized local testing; credentials and query parameters in the URL are rejected. The command returns a structured result with state `SUCCEEDED`, `PARTIAL`, `FAILED` or `CANCELLED`; failures exit nonzero. The default task deadline is 90 seconds. Interrupt the foreground command to cancel. A successful command can still contain incomplete evidence.

## Task-scoped attachments

The owner can upload inputs in the dashboard before starting a matching mint, chain and profile check on that installation. During the explicit local check, the launcher adopts a sole matching requested task and downloads only its frozen inputs. If more than one match exists, select one explicitly; ambiguous requests fail before model work. Do not retry automatically.

```bash
node SKILL_DIR/scripts/run-agent3.mjs --task-id UUID TASK.json GATEWAY_URL MODEL /absolute/path/to/codex
```

The selector also works before `start`; `--worker` can appear before or after `--task-id`. The dashboard stores requests and inputs; it does not launch a remote worker or poll the computer.

Downloads are bounded to 10 files, 512 KiB per file and 2 MiB total, with exact byte length and SHA-256 verification. Files have mode 0600 in a private temporary task workspace. The main agent can read them during execution; they never execute automatically and ordinary cleanup deletes the workspace. Result `external_inputs` contains names, sizes, digests and receipt paths, not retained download locations. Crashes can prevent cleanup; failures do not promise retained attachment metadata.

Uploaded text is supplemental, untrusted data rather than authoritative on-chain evidence or confidential private instructions. The provider receives metadata and bounded UTF-8 text from txt/md/json/csv only, capped at 12 KiB of JSON-encoded text. Other file contents are not included as model text. Existing evidence and report validators still apply. Task guidance comes from the frozen server snapshot; private service instructions and provider keys remain server-side.

## Data processing and local records

The local worker is for this mint task. It receives the public mint address, chain, profile and generated task identifier; task evidence and report are available through the fixed evidence tool. Inference goes through our gateway to the operator's configured model provider. The gateway receives the installation public key and signed, task-scoped requests, continuation identifiers and validated evidence tool outputs. Tasks are associated with the installation identifier and retained in server task history. Normal parent chat history is not supplied to this launcher. Its transport discards worker client instructions and unrelated transcript text when building upstream requests; this does not establish absolute confidentiality.

The service processes task inputs, public-chain evidence, model output and diagnostic task history for operation and troubleshooting. Network infrastructure can observe connection metadata. This package does not establish a server retention period, deletion policy or access policy; obtain those details from the operator before submitting sensitive information. Do not submit private keys, credentials, wallet files, private documents or unrelated conversations. Provider terms and retention also depend on the confirmed service configuration.

The launcher creates a temporary owner-only task home, a local loopback relay and task files, filters inherited provider credentials, and requests a read-only Codex sandbox. It removes its temporary home during ordinary cleanup and does not rewrite normal Codex settings. Same-user/root access, CLI behavior, operating-system policy and abrupt crashes remain outside these guarantees. A crash can leave temporary files. Host isolation and prompt secrecy are not proven.

## Background tasks and retention

```bash
node SKILL_DIR/scripts/run-agent3.mjs start JOB_ROOT TASK.json GATEWAY_URL MODEL /absolute/path/to/codex
node SKILL_DIR/scripts/run-agent3.mjs status JOB_ROOT JOB_ID
node SKILL_DIR/scripts/run-agent3.mjs result JOB_ROOT JOB_ID
node SKILL_DIR/scripts/run-agent3.mjs cancel JOB_ROOT JOB_ID
```

JOB_ROOT must be a dedicated owner-only canonical absolute path; resolve symlink aliases first. Keep the returned job_id. The background worker records the task, endpoint, model, executable path, state and result locally beneath JOB_ROOT. These records persist until the user removes a completed job directory; automatic retention cleanup is not provided. Do not delete active job directories.

A cancellation request is not confirmation of termination. Poll for a terminal result. `STALE` or `JOB_START_UNCONFIRMED` means the outcome is unknown; do not automatically repeat paid model work. Results are snapshots at completion time and may become stale. A host or parent-process crash can prevent cleanup and terminal acknowledgement.

## Compatibility and scope

The prepared package targets Node 24 on macOS or Linux. Windows is unqualified. Real CLI help can check required flags, but offline installation and fixture tests do not qualify live model behavior. A canonical build completed real Codex and Claude runs against a private VM gateway. The later Codex/Helius report remained PARTIAL: holder sampling was unavailable, pool discovery was incomplete, and three Raydium CPMM pools were verified. That private-path result does not qualify this public installation or endpoint. A genuine Codex task against the deployed public pilot also returned validated PARTIAL evidence. Current public Claude execution has not been repeated; its earlier private-VM qualification remains separate evidence. No rugproof or confidentiality guarantee is made.

The runtime retains optional Claude Code transport from the source build. It can be selected with `--worker claude-code` before the task path or `start`, and an absolute Claude executable path; its prerequisite check uses the same selector. It requests an evidence-only tool set, which is not an OS sandbox. Claude completed earlier bounded private-VM live tests; the public pilot has currently been qualified with Codex. No direct-provider templates are included in this export.
