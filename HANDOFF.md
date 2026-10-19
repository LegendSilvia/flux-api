# Handoff: FLUX Playground on Cloudflare Workers AI

**For:** Claude Code (running on Chihuahua's machine)
**Goal:** Deploy a small Cloudflare Worker that lets Chihuahua try Black Forest Labs' FLUX image models through Workers AI, from a browser page.
**Scope:** Exploration only. **No Roblox Studio integration yet** — do not add Studio, Hi3DGen, Blender or 3D steps.

---

## Context

- Chihuahua's Cloudflare account currently has **no Workers** deployed. This will be the first one.
- The claude.ai Cloudflare connector can read Workers, KV, D1, R2 and docs, but it **cannot deploy Workers or call Workers AI**. That's why deployment goes through Wrangler here.
- Models used (all Cloudflare-hosted):

| Key | Model ID | Input style | Notes |
|---|---|---|---|
| `flux-1-schnell` | `@cf/black-forest-labs/flux-1-schnell` | JSON | `prompt`, `steps` (≤ 8, default 4), `seed`. No width/height. |
| `flux-2-klein-4b` | `@cf/black-forest-labs/flux-2-klein-4b` | multipart | Steps fixed at 4. Width/height. Up to 4 reference images (`input_image_0..3`, each < 512×512). |
| `flux-2-klein-9b` | `@cf/black-forest-labs/flux-2-klein-9b` | multipart | Same as 4B, higher quality. |
| `flux-2-dev` | `@cf/black-forest-labs/flux-2-dev` | multipart | Adjustable steps (docs example uses 25). Slowest. |

All four return `{ image: "<base64>" }`.

## Files

```
flux-playground/
├── package.json        # wrangler ^4 as devDependency
├── wrangler.jsonc      # name, AI binding "AI", Text rule for .html imports
├── src/index.js        # Worker: GET /, GET /models, POST /generate
├── src/page.html       # Single-page UI (prompt, model, size, steps, seed, reference image, history)
└── HANDOFF.md          # this file
```

## Steps

1. **Install**
   ```bash
   cd flux-playground
   npm install
   ```
2. **Log in** (opens a browser; Chihuahua approves it — do not handle tokens yourself)
   ```bash
   npx wrangler login
   npx wrangler whoami
   ```
3. **Try locally first.** The AI binding always calls the real Workers AI, so this uses account quota.
   ```bash
   npx wrangler dev
   ```
   Open the printed localhost URL, generate one image with each model.
4. **Protect before deploying.** A public `*.workers.dev` URL lets anyone spend Workers AI usage. Ask Chihuahua to choose a key, then:
   ```bash
   npx wrangler secret put ACCESS_KEY
   ```
   (Chihuahua types the value at the prompt. Don't echo it, log it, or write it to a file.)
5. **Deploy** — confirm with Chihuahua before running this.
   ```bash
   npx wrangler deploy
   ```
6. **Smoke test** the deployed URL:
   ```bash
   curl -s https://<worker-url>/models
   curl -s -X POST https://<worker-url>/generate \
     -H "x-access-key: $FLUX_KEY" \
     -F "prompt=low-poly treasure chest, game asset, white background" \
     -F "model=flux-2-klein-4b" -F width=1024 -F height=1024 \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error){console.error(j.error);process.exit(1)}require("fs").writeFileSync("test.png",Buffer.from(j.image,"base64"));console.log(j.model,j.ms+"ms","-> test.png")})'
   ```
   (`FLUX_KEY` is set by Chihuahua in their own shell.)

## Acceptance criteria

- [ ] `GET /` serves the UI; `GET /models` lists the four models.
- [ ] Each of the four models returns an image from the UI.
- [ ] Reference-image upload works on a klein model (e.g. "the object in image 0, redrawn as a low-poly game asset").
- [ ] With `ACCESS_KEY` set, `/generate` returns 401 without the header and works with it.
- [ ] `npx wrangler tail` shows no unhandled errors during a few generations.

## Things to verify while testing (not confirmed from docs)

- Whether `seed` is accepted by the FLUX.2 models. If a FLUX.2 call fails with a schema error mentioning `seed`, stop sending it for those models in `src/index.js`.
- The real upper bound for `steps` on `flux-2-dev` (code clamps to 1–50). Adjust if the API rejects higher values.
- Width/height limits for FLUX.2 (code snaps to multiples of 16 in 256–1536).
- Response format of FLUX.2 images (PNG vs JPEG). The Worker sniffs the base64 header, so this should just work.

## Out of scope for now (possible next steps — ask first)

- Saving generations to an R2 bucket with prompt metadata.
- Batch prompts / style-locking via a fixed reference image.
- Anything Roblox: image → 3D (Hi3DGen), Blender cleanup, Studio import.
