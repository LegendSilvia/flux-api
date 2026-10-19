import PAGE from "./page.html";

/**
 * FLUX playground on Cloudflare Workers AI.
 *
 * GET  /          -> web UI
 * GET  /models    -> model list (JSON)
 * POST /generate  -> multipart form: prompt, model, width, height, steps, seed, ref (optional image),
 *                    transparent ("1"/"true" for a PNG with the background removed)
 *                    returns JSON { image (base64), mime, model, ms, transparent, prompt }
 *
 * FLUX can't output alpha; asked for "transparent" it paints a checkerboard. So with transparent=1 the
 * Worker strips that wording, asks for a plain background, then cuts the subject out with the Images
 * binding (segment: "foreground"). If the cut-out fails, the opaque image comes back with `warning`.
 *
 * Protection: set a secret ACCESS_KEY (`npx wrangler secret put ACCESS_KEY`, or the dashboard).
 * /generate requires header `x-access-key: <value>`, and refuses all requests until the secret exists
 * (fails closed, so a Git-driven first deploy can't expose Workers AI usage). For `wrangler dev`,
 * put ACCESS_KEY in .dev.vars.
 */

const MODELS = {
  "flux-1-schnell": {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 [schnell] - fastest, prompt only",
    multipart: false,
    steps: { min: 1, max: 8, default: 4 },
    size: false,
    ref: false,
  },
  "flux-2-klein-4b": {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 [klein] 4B - fast, size + reference image",
    multipart: true,
    steps: null, // fixed at 4 on Workers AI
    size: true,
    ref: true,
  },
  "flux-2-klein-9b": {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 [klein] 9B - better quality, still fast",
    multipart: true,
    steps: null,
    size: true,
    ref: true,
  },
  "flux-2-dev": {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 [dev] - highest quality, slowest",
    multipart: true,
    steps: { min: 1, max: 50, default: 25 },
    size: true,
    ref: true,
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// Snap to a multiple of 16, within 256..1536
const snapSize = (value) => {
  const n = clampInt(value, 256, 1536, 1024);
  return Math.round(n / 16) * 16;
};

const TRANSPARENCY_WORDS =
  /[,;]?\s*\b(?:(?:on|with|in)\s+(?:an?\s+)?)?(?:transparen\w*|alpha|checker(?:ed|board)?)(?:\s+(?:background|backgroud|bg))?\b|\bpng\b/gi;
const PLAIN_BACKGROUND =
  "centered, isolated subject on a plain flat solid-color background, no shadow, no checkerboard pattern";

// Rewrite a prompt so the model draws a background that's easy to cut out.
const prepTransparentPrompt = (prompt) => {
  const cleaned = prompt.replace(TRANSPARENCY_WORDS, "").replace(/\s+([,;])/g, "$1").replace(/\s{2,}/g, " ").replace(/[\s,;]+$/, "").trim();
  return `${cleaned || prompt}, ${PLAIN_BACKGROUND}`;
};

const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const bytesToBase64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

async function removeBackground(env, b64) {
  const output = await env.IMAGES.input(new Blob([base64ToBytes(b64)]).stream())
    .transform({ segment: "foreground" })
    .output({ format: "image/png" });
  return bytesToBase64(new Uint8Array(await output.response().arrayBuffer()));
}

const sniffMime = (b64) => {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
};

async function generate(request, env) {
  if (!env.ACCESS_KEY) {
    return json({ error: "ACCESS_KEY is not configured on this Worker; generation is disabled." }, 503);
  }
  if (request.headers.get("x-access-key") !== env.ACCESS_KEY) {
    return json({ error: "Missing or wrong access key." }, 401);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Send the request as multipart/form-data." }, 400);
  }

  const rawPrompt = String(form.get("prompt") || "").trim();
  if (!rawPrompt) return json({ error: "Prompt is required." }, 400);
  if (rawPrompt.length > 2048) return json({ error: "Prompt is longer than 2048 characters." }, 400);

  const transparent = ["1", "true", "on", "yes"].includes(String(form.get("transparent") || "").toLowerCase());
  const prompt = transparent ? prepTransparentPrompt(rawPrompt) : rawPrompt;

  const key = String(form.get("model") || "flux-2-klein-4b");
  const model = MODELS[key];
  if (!model) return json({ error: `Unknown model "${key}".` }, 400);

  const seedRaw = form.get("seed");
  const seed = seedRaw === null || seedRaw === "" ? null : clampInt(seedRaw, 0, 2147483647, null);

  const started = Date.now();
  let result;

  try {
    if (!model.multipart) {
      // FLUX.1 [schnell]: plain JSON input
      const input = {
        prompt,
        steps: clampInt(form.get("steps"), model.steps.min, model.steps.max, model.steps.default),
      };
      if (seed !== null) input.seed = seed;
      result = await env.AI.run(model.id, input);
    } else {
      // FLUX.2 models: multipart input, even for prompt-only requests
      const body = new FormData();
      body.append("prompt", prompt);
      body.append("width", String(snapSize(form.get("width"))));
      body.append("height", String(snapSize(form.get("height"))));
      if (model.steps) {
        body.append(
          "steps",
          String(clampInt(form.get("steps"), model.steps.min, model.steps.max, model.steps.default)),
        );
      }
      if (seed !== null) body.append("seed", String(seed));

      const ref = form.get("ref");
      if (model.ref && ref && typeof ref !== "string" && ref.size > 0) {
        // Reference images must be under 512x512; the UI downscales before upload.
        body.append("input_image_0", ref, "ref.png");
      }

      // Serialising through Response gives us the stream + boundary header.
      const packed = new Response(body);
      result = await env.AI.run(model.id, {
        multipart: {
          body: packed.body,
          contentType: packed.headers.get("content-type"),
        },
      });
    }
  } catch (err) {
    console.error("AI.run failed", key, err);
    return json({ error: `Model call failed: ${err?.message || err}` }, 502);
  }

  const image = result?.image;
  if (!image) return json({ error: "Model returned no image.", raw: result }, 502);

  const meta = { model: key, prompt, transparent: false };
  if (transparent) {
    try {
      const cutout = await removeBackground(env, image);
      return json({ image: cutout, mime: "image/png", ...meta, transparent: true, ms: Date.now() - started });
    } catch (err) {
      console.error("Background removal failed", err);
      meta.warning = `Background removal failed, returning the opaque image: ${err?.message || err}`;
    }
  }

  return json({ image, mime: sniffMime(image), ...meta, ms: Date.now() - started });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "GET" && pathname === "/models") {
      return json(
        Object.entries(MODELS).map(([key, m]) => ({
          key,
          label: m.label,
          steps: m.steps,
          size: m.size,
          ref: m.ref,
        })),
      );
    }

    if (request.method === "POST" && pathname === "/generate") {
      return generate(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};
