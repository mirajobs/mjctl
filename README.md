# mjctl — MiraJobs CLI

A CLI tool for tech job seekers to discreetly manage their MiraJobs account from the terminal and
explore new opportunities without risking their current role.

You never know when the next wave of layoffs will come, so why not create an anonymous profile and
let recruiters "apply" to you?

## How it works

1. Create an anonymous job seeker profile directly from your terminal.
2. Recruiters contact you with job proposals.
3. If a proposal interests you, reveal your identity and proceed as usual.

## Prerequisites

- Linux, macOS or Windows
- Node.js 18+ (recommended 20+)

## Install and run (Node + npm)

Global install:

```bash
npm install -g mjctl
mjctl --help
```

Or run from source in this repo:

```bash
npm install
npm run build
node bin/mjctl --help
```

Notes:

- The CLI is exposed via the npm `bin` entry (`mjctl`) with a shebang; running `node bin/mjctl --help` after build works locally as well.
- Tokens are stored using an encrypted file-based keychain.

## Security & Safety

- Passwordless authentication (OTP by email).
- Short‑lived access tokens with automatic refresh; tokens are rotated and never echoed.
- Secure token storage:
  - Encrypted file keychain (PBKDF2 + AES‑GCM). By default a machine footprint–based passphrase is
    used; set `MJCTL_KEYCHAIN_PASSPHRASE` in `.env` for an even higher level of security.
- Local PII redaction:
  - When using server-side AI to automatically fill out your profile based on a resume (CV), it is
    recommended to first remove your personal identifiable information (PII) locally. See “Redacting
    a resume” below or run: `mjctl redact ./resume.pdf`

## Quickstart

### 1. Authenticate

- `mjctl auth login --email you@example.com`
- Enter the code from your email.
- Check status (optionally):
  - `mjctl auth status`

### 2. Create a profile

- Create an empty profile (provide title only):
  - `mjctl profiles create --title "Senior Front-End Developer"`
- Create a pre-filled profile using AI from a resume:
  - `mjctl profiles create --from-resume ./resume.pdf`
- The server returns a draft YAML, which is saved locally (e.g., `./profile-<ID>.yaml`). Edit it in
  your editor to fill out details.
- Save updates back to server:
  - `mjctl profiles save ./profile-<ID>.yaml -y`
- Consider creating multiple profiles, each tailored for a specific role or skill set.

### 3. Set location

- Auto-detect by IP using [ip2location.com](https://www.ip2location.com/):
  - `mjctl location set --detect`
- Manual (non-interactive):
  - `mjctl location set --country-code US --region "California" --city "San Francisco" -y`
- Interactive picker (default if no flags):
  - `mjctl location set`
- Show current saved location:
  - `mjctl location show`

You will receive an email once the profile is approved and becomes visible to recruiters.

## Redacting a resume (local PII scrub)

You can redact any personally identifiable information (PII) from your resume locally before using
it in `mjctl profiles create --from-resume` for maximum confidentiality.

- `mjctl redact ./resume.pdf`
- Output:
  - `./resume.redacted.txt`
  - `./resume.pii.report.json`
- Modes: default masking/hash per PII type; PDF mode adds heading-based name detection.
- Review locally before upload.

## Affiliate Program

When a recruiter hires a jobseeker via Mirajobs they pay a commission fee. You can refer jobseekers
and recruiters and earn revenue share for each hire.

## Commands cheatsheet

- Auth
  - `mjctl auth login [--email you@example.com]`
  - `mjctl auth status`
  - `mjctl auth logout`
- Profiles
  - `mjctl profiles list [--json]`
  - `mjctl profiles load <idOrSlug> [--out ./profile-<id>.yaml] [-f]`
  - `mjctl profiles create [--title "..."] [--from-resume ./resume.pdf] [--out ./profile-<id>.yaml]`
  - `mjctl profiles save <fileOrId> [--validate-only] [-y]`
  - `mjctl profiles delete <idOrSlug> [-y]`
- Location
  - `mjctl location show [--json]`
  - `mjctl location set [--detect] [--country-code CC --region NAME --city NAME] [-y]`
- Redaction
  - `mjctl redact <file.pdf|txt> [--out ./outputBase]`
  - Produces: `base`.redacted.txt and `base`.pii.report.json
- Affiliate Program
  - `mjctl affiliate link`
  - `mjctl affiliate stats`

## Configuration (optional)

Environment variables (prefix MJCTL_):

- MJCTL_KEYCHAIN_PASSPHRASE: Optional passphrase for file backend; if unset, a machine-specific
  default is derived

Variables can be stored in `.env` file. See src/lib/config.ts for defaults.

## Troubleshooting

- “No auth token found”
  - Run: `mjctl auth login --email you@example.com`
- “Access denied” or token expired
  - The client auto-refreshes tokens; re-run or `mjctl auth login` if refresh fails.
- Keychain decryption failed
  - The file backend uses a passphrase. If it changed, you may need to re-login:
    - `mjctl auth logout`
    - Optionally set `MJCTL_KEYCHAIN_PASSPHRASE`, then:
    - `mjctl auth login --email you@example.com`
- Location ambiguity (non-TTY)
  - Provide precise --region/--city or run interactively.

## Develop

- Run locally: `npm run dev` (ts-node via tsx)
- Build: `npm run build` (outputs to `dist/`)
- Test: `npm test` (Vitest)

## License

MIT — see LICENSE.
