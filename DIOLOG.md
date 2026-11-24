# Diolog fork of Uptime Kuma

This fork runs status.diolog.app. It is upstream Uptime Kuma 2.5.12 plus one feature: an AI visual
check on the real-browser monitor.

## What the fork adds

- **AI visual check** (`server/diolog/visual-check.js`). A real-browser monitor with "AI visual check"
  ticked renders the page at 1440px wide with reduced motion, scrolls it so scroll-revealed content
  draws, and sends a JPEG of up to 4000px of the page to a vision model on Amazon Bedrock (GPT-6 Luna
  by default, medium reasoning effort). An error page, a blank page, missing styles, broken images, a
  broken layout, or anything in the monitor's "What must be on this page" text that is missing marks
  the monitor down with the model's one-sentence summary. A check that cannot run fails with that
  reason rather than passing.
  - Settings: `UPTIME_KUMA_AI_MODEL` (default `global.openai.gpt-6-luna`), `UPTIME_KUMA_AI_EFFORT`
    (default `medium`), `AWS_REGION` (default `ap-southeast-2`). Credentials come from the AWS SDK's
    default chain; on the status cell that is the EC2 instance role.
  - Schema: `db/knex_migrations/2026-11-24-0000-diolog-ai-visual-check.js` adds `ai_visual_check` and
    `ai_visual_prompt` to `monitor`. The form fields are in `src/pages/EditMonitor.vue`.
- **Setup and provisioning scripts** (`extra/diolog/`). `setup-admin.js` creates the admin account
  against localhost before the instance is reachable; `provision.js` brings the monitors, settings and
  the status page to the state written in that file and is safe to re-run.
- **Image** (`docker/diolog.dockerfile`), built for linux/arm64 and pushed by `extra/diolog/push-image.sh`
  to the status cell's own ECR repository, tagged with the commit. Upstream's GitHub workflows are removed
  on this branch, and nothing is published to the GitHub registry.

## Where it runs

In its own AWS cell, defined in the dAIolog repo at `apps/infra/cells/status` (Pulumi): its own VPC, one
Graviton node running k3s with this image, Caddy for TLS and SQLite on an encrypted EBS volume. To ship
a change: commit to `diolog`, run `extra/diolog/push-image.sh`, put the digest it prints in that project's
`Pulumi.prod.yaml` as `kumaImageDigest`, and run `pulumi up` there.

To change the monitors, edit `SITES` in `extra/diolog/provision.js` and run it against the live site:

```bash
aws ssm get-parameter --region ap-southeast-2 --with-decryption \
  --name /diolog-status-cell/kuma-admin-password --query Parameter.Value --output text \
  | KUMA_USERNAME=diolog node extra/diolog/provision.js https://status.diolog.app
```

## Taking upstream changes

`git fetch upstream --tags && git merge <upstream tag>` on `diolog`. The fork touches
`server/monitor-types/real-browser-monitor-type.js`, `server/model/monitor.js` (two `toJSON` fields),
`server/server.js` (two lines in `editMonitor`), `src/pages/EditMonitor.vue` and `src/lang/en.json`,
so conflicts land there if anywhere.
