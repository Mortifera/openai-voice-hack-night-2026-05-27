#!/usr/bin/env bash
#
# Pre-generate the 4 Mixtape-demo hero images via OpenAI gpt-image-1.
# Output: apps/director/src/renderer/src/assets/{matte-vinyl,cassette,holographic,tokyo-neon}.png
#
# Requires: OPENAI_API_KEY in env (or apps/director/.env / repo-root .env).
# Run from repo root:  bash apps/director/scripts/gen-images.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ASSETS_DIR="${REPO_ROOT}/apps/director/src/renderer/src/assets"
mkdir -p "${ASSETS_DIR}"

# Load .env if key not in shell env.
if [ -z "${OPENAI_API_KEY:-}" ]; then
  for env_file in "${REPO_ROOT}/.env" "${REPO_ROOT}/apps/director/.env"; do
    if [ -f "${env_file}" ]; then
      # shellcheck disable=SC1090
      set -a; source "${env_file}"; set +a
    fi
  done
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY not set in env or .env files." >&2
  exit 1
fi

MODEL="${OPENAI_IMAGE_MODEL:-gpt-image-1}"
SIZE="${OPENAI_IMAGE_SIZE:-1024x1024}"
QUALITY="${OPENAI_IMAGE_QUALITY:-high}"

gen() {
  local slug="$1"
  local prompt="$2"
  local out="${ASSETS_DIR}/${slug}.png"

  echo "[gen] ${slug} → ${out}"

  local payload
  payload=$(jq -n \
    --arg model "${MODEL}" \
    --arg prompt "${prompt}" \
    --arg size "${SIZE}" \
    --arg quality "${QUALITY}" \
    '{model:$model, prompt:$prompt, size:$size, quality:$quality, n:1}')

  local resp
  resp=$(curl -sS -X POST https://api.openai.com/v1/images/generations \
    -H "Authorization: Bearer ${OPENAI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "${payload}")

  # Surface API errors loudly.
  if echo "${resp}" | jq -e '.error' > /dev/null 2>&1; then
    echo "[gen:${slug}] API error:" >&2
    echo "${resp}" | jq '.error' >&2
    return 1
  fi

  echo "${resp}" \
    | jq -r '.data[0].b64_json' \
    | base64 -d > "${out}"

  local size_kb
  size_kb=$(( $(stat -f%z "${out}" 2>/dev/null || stat -c%s "${out}") / 1024 ))
  echo "[gen] ${slug} ✓ ${size_kb}KB"
}

# Run all 4 in parallel — independent API calls.
gen "matte-vinyl" \
  "Premium matte black vinyl record sleeve on a soft grey backdrop, minimalist, soft directional lighting from upper-left, monochrome composition, deep blacks and graphite, no text, no logos, no people, product still life photography, shallow depth of field, square crop" &

gen "cassette" \
  "Translucent amber cassette tape close-up, 1980s vintage aesthetic, warm directional lighting, visible tape reels through plastic, no text, no logos, no labels, product photography on dark walnut surface, soft shadows, warm orange and amber tones, square crop" &

gen "holographic" \
  "Abstract iridescent holographic foil texture, electric pastel rainbow reflections, pink turquoise green gold gradients, light caustics and refraction, smooth liquid surface, no text, no logos, no objects, dreamy, square crop" &

gen "tokyo-neon" \
  "Stylized synthwave Tokyo neon street at night, vibrant pink and cyan neon signs, rainy reflective pavement, no people, no text, no logos, vinyl record cover art aesthetic, atmospheric, cinematic, square crop" &

wait

echo "[gen] all 4 images done."
ls -lah "${ASSETS_DIR}"/*.png
