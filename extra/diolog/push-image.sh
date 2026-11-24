#!/usr/bin/env bash
# Build the Diolog fork's image for linux/arm64 and push it to the status cell's own ECR repository
# (created by dAIolog apps/infra/cells/status). Prints the digest to put in that project's
# Pulumi.prod.yaml as kumaImageDigest. Tags are immutable, so each push is tagged with the commit.
#
#   extra/diolog/push-image.sh            # needs Docker with buildx and AWS credentials for 614788684359
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-2}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
REPO="${REGISTRY}/diolog-status-cell/uptime-kuma"

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "push-image: the working tree has uncommitted changes; commit them so the tag names what was built" >&2
  exit 1
fi
TAG="$(git rev-parse --short=12 HEAD)"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker buildx build --platform linux/arm64 -f docker/diolog.dockerfile -t "${REPO}:${TAG}" \
  --provenance=false --metadata-file /tmp/diolog-status-image.json --push .
DIGEST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' /tmp/diolog-status-image.json)"
echo "pushed ${REPO}:${TAG}"
echo "kumaImageDigest: ${DIGEST}"
