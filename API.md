# FLUX Image API

Generates images with FLUX.2 [klein] 4B on Cloudflare Workers AI. Built to be called by AI agents as well as people.

Base URL: `https://flux-playground.<your-subdomain>.workers.dev`

The live, always-current version of this reference is `GET /api` (JSON). If this file and `/api` disagree, `/api` is right.

## Authentication

Every `POST /generate` needs:

| Header | Value |
|---|---|
| `x-access-key` | the Worker's `ACCESS_KEY` secret |
| `CF-Access-Client-Id` | Cloudflare Access service token ID (only if Access protects the Worker) |
| `CF-Access-Client-Secret` | Cloudflare Access service token secret (only if Access protects the Worker) |

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api` | Machine-readable description: fields, scenarios, styles, defaults, costs, errors |
| GET | `/usage` | Today's neurons and this month's Images transformations vs. the caps |
| POST | `/generate` | Make an image |
| GET | `/` | Web playground |

## POST /generate

Send `application/json` (recommended for agents) or `multipart/form-data`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | Up to 2048 chars. Describe the subject; the scenario adds framing. |
| `scenario` | string | no | Preset, see below. Default `custom`. |
| `style` | string | no | Art style, see below. Default `none`. |
| `width`, `height` | integer | no | 256–1536, snapped to multiples of 16. Default from scenario. |
| `transparent` | boolean | no | `true` returns a PNG with the background removed. Default from scenario. |
| `seed` | integer | no | Same seed + same inputs gives a similar image. |
| `ref` | image | `edit` only | JSON: base64 or data URL string. Multipart: file field. Call it "image 0" in the prompt. Large images are downscaled automatically. |

`model` and `steps` are ignored: the model is locked to `flux-2-klein-4b` (4 steps). If you send them, the response says so in `notes`.

### Scenarios

| Key | Use for | Default size | Transparent |
|---|---|---|---|
| `custom` | Prompt used exactly as written | 1024×1024 | no |
| `icon` | Game/UI icon or emblem | 1024×1024 | yes |
| `game-asset` | Single object or prop | 1024×1024 | yes |
| `character` | Full-body character concept | 832×1216 | yes |
| `logo` | Logo or title text (put the words in "quotes") | 1024×1024 | yes |
| `texture` | Seamless tileable surface | 1024×1024 | no |
| `environment` | Scene or location concept | 1216×832 | no |
| `thumbnail` | 16:9 promo / banner | 1536×864 | no |
| `photo` | Photorealistic product shot | 1024×1024 | no |
| `edit` | Change or restyle a reference image (needs `ref`) | 1024×1024 | no |

### Styles

`none`, `low-poly`, `pixel-art`, `flat-vector`, `cartoon`, `hand-painted`, `anime`, `3d-render`, `realistic`

### Response (200)

```json
{
  "image": "<base64>",
  "mime": "image/png",
  "model": "flux-2-klein-4b",
  "scenario": "game-asset",
  "style": "low-poly",
  "width": 1024,
  "height": 1024,
  "transparent": true,
  "prompt": "<the full prompt sent to the model>",
  "estimated_neurons": 105,
  "ms": 2140,
  "notes": ["optional: settings that were ignored or adjusted"],
  "warning": "optional: e.g. background removal skipped"
}
```

Check `transparent` in the response: if you asked for it and it is `false`, read `warning`.

### Errors

| Status | Meaning | What to do |
|---|---|---|
| 400 | Bad input; `error` names the field and lists valid values | Fix the field and retry |
| 401 | Missing or wrong `x-access-key` | Check the key |
| 429 | Daily budget reached | Stop until 00:00 UTC; don't retry in a loop |
| 502 | Model call failed | Retry once later |
| 503 | Worker not configured | Tell the owner |

## Examples

curl:

```bash
curl -s -X POST "$FLUX_URL/generate" \
  -H "x-access-key: $FLUX_KEY" -H "content-type: application/json" \
  -d '{"prompt":"flaming sword","scenario":"game-asset","style":"low-poly","transparent":true}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error)throw new Error(j.error);require("fs").writeFileSync("out.png",Buffer.from(j.image,"base64"));console.log(j.scenario,j.transparent,j.ms+"ms")})'
```

PowerShell:

```powershell
$body = @{ prompt = "flaming sword"; scenario = "game-asset"; style = "low-poly"; transparent = $true } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri "$env:FLUX_URL/generate" -Headers @{ "x-access-key" = $env:FLUX_KEY } -ContentType "application/json" -Body $body
[IO.File]::WriteAllBytes("$PWD\out.png", [Convert]::FromBase64String($r.image))
```

JavaScript:

```js
const res = await fetch(`${FLUX_URL}/generate`, {
  method: "POST",
  headers: { "x-access-key": FLUX_KEY, "content-type": "application/json" },
  body: JSON.stringify({ prompt: "flaming sword", scenario: "game-asset", style: "low-poly", transparent: true }),
});
const data = await res.json();
if (!res.ok) throw new Error(data.error);
// data.image is base64 PNG
```

## Instructions for an AI agent

Paste this into the agent's system prompt or tool description:

```text
You can generate images with the FLUX Image API.
Call POST {BASE_URL}/generate with JSON and header x-access-key: {KEY}.
Fields: prompt (required), scenario, style, width, height, transparent, seed, ref.
Pick the scenario that matches the request:
  icon (UI/game icon), game-asset (single object/prop), character (full-body character),
  logo (text logo; put the exact words in quotes), texture (seamless tileable surface),
  environment (scene/location), thumbnail (16:9 banner), photo (product photo),
  edit (modify a supplied image; send it as ref and call it "image 0"), custom (prompt as-is).
Optional style: low-poly, pixel-art, flat-vector, cartoon, hand-painted, anime, 3d-render, realistic.
Write the prompt as a short description of the subject only (what it is, colors, materials, mood).
Don't add framing, background or "transparent" words; the scenario handles that.
Set transparent true only when the image will be placed on top of something else.
The response has image (base64) and mime; check transparent and warning in the response.
If you get 429, stop: the daily budget is used up until 00:00 UTC. Don't retry.
Use GET {BASE_URL}/api if you need the current list of scenarios and styles.
```

## Function-calling tool definition

For agents that use JSON-schema tools (Claude, OpenAI, etc.):

```json
{
  "name": "generate_image",
  "description": "Generate an image with FLUX.2 [klein] 4B. Pick the scenario that matches the use; it sets framing, size and transparency. Returns base64 image.",
  "input_schema": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "Short description of the subject only. Max 2048 chars." },
      "scenario": {
        "type": "string",
        "enum": ["custom", "icon", "game-asset", "character", "logo", "texture", "environment", "thumbnail", "photo", "edit"]
      },
      "style": {
        "type": "string",
        "enum": ["none", "low-poly", "pixel-art", "flat-vector", "cartoon", "hand-painted", "anime", "3d-render", "realistic"]
      },
      "transparent": { "type": "boolean", "description": "Remove the background (PNG with alpha)." },
      "width": { "type": "integer", "minimum": 256, "maximum": 1536 },
      "height": { "type": "integer", "minimum": 256, "maximum": 1536 },
      "seed": { "type": "integer", "minimum": 0 },
      "ref": { "type": "string", "description": "Reference image as base64 or data URL. Required for scenario edit." }
    },
    "required": ["prompt"]
  }
}
```

Your code that handles this tool forwards the arguments as the JSON body of `POST /generate` with the `x-access-key` header.

## Cost and limits

- About 105 neurons per 1024×1024 image, 157 for portrait/wide sizes. The free allowance is 10,000 neurons a day, so about 60–90 images.
- Background removal and reference-image downscaling each count as one Images transformation (5,000 a month free).
- The Worker refuses requests before they would pass the caps (`NEURON_DAILY_LIMIT`, default 9,500; `IMAGES_MONTHLY_LIMIT`, default 4,900). Check `GET /usage`.
