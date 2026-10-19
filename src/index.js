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
 * GET  /usage     -> today's Workers AI neurons and this month's background removals vs. the caps
 *
 * Budget guard: every call reserves its estimated cost in D1 (binding USAGE) before running, and is
 * refused with 429 if that would pass the cap. Caps default to just under the free allowances
 * (10,000 neurons/day, 5,000 Images transformations/month); override with vars NEURON_DAILY_LIMIT
 * and IMAGES_MONTHLY_LIMIT. Estimates use Cloudflare's published per-model neuron prices.
 *
 * Protection: set a secret ACCESS_KEY (`npx wrangler secret put ACCESS_KEY`, or the dashboard).
 * /generate requires header `x-access-key: <value>`, and refuses all requests until the secret exists
 * (fails closed, so a Git-driven first deploy can't expose Workers AI usage). For `wrangler dev`,
 * put ACCESS_KEY in .dev.vars.
 */

// Neuron estimates from https://developers.cloudflare.com/workers-ai/platform/pricing/
// (tiles are 512x512, rounded up; `ref` is the input image when one is sent).
const tiles = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);

const MODELS = {
  "flux-1-schnell": {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 [schnell] - fastest, prompt only",
    multipart: false,
    steps: { min: 1, max: 8, default: 4 },
    size: false,
    ref: false,
    cost: ({ steps }) => 4.8 * tiles(1024, 1024) + 9.6 * steps,
  },
  "flux-2-klein-4b": {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 [klein] 4B - fast, size + reference image",
    multipart: true,
    steps: null, // fixed at 4 on Workers AI
    size: true,
    ref: true,
    cost: ({ w, h, ref }) => 26.05 * tiles(w, h) + (ref ? 5.37 : 0),
  },
  "flux-2-klein-9b": {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 [klein] 9B - better quality, still fast",
    multipart: true,
    steps: null,
    size: true,
    ref: true,
    cost: ({ w, h, ref }) => 1363.64 + 181.82 * Math.ceil(Math.max(0, (w * h) / 1048576 - 1)) + (ref ? 181.82 : 0),
  },
  "flux-2-dev": {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 [dev] - highest quality, slowest",
    multipart: true,
    steps: { min: 1, max: 50, default: 25 },
    size: true,
    ref: true,
    cost: ({ w, h, steps, ref }) => (37.5 * tiles(w, h) + (ref ? 18.75 : 0)) * steps,
  },
};

const DEFAULT_NEURON_DAILY_LIMIT = 9500;
const DEFAULT_IMAGES_MONTHLY_LIMIT = 4900;

const limits = (env) => ({
  neurons: Number(env.NEURON_DAILY_LIMIT) || DEFAULT_NEURON_DAILY_LIMIT,
  images: Number(env.IMAGES_MONTHLY_LIMIT) || DEFAULT_IMAGES_MONTHLY_LIMIT,
});

// Counters reset with Cloudflare's allowances: neurons at 00:00 UTC, Images monthly.
const periods = () => {
  const iso = new Date().toISOString();
  return { neurons: `neurons:${iso.slice(0, 10)}`, images: `images:${iso.slice(0, 7)}` };
};

// Atomically add `amount` to a counter unless that would pass `limit`. Returns the new total or null.
async function reserve(env, period, amount, limit) {
  if (amount > limit) return null;
  const row = await env.USAGE.prepare(
    `INSERT INTO usage (period, amount) VALUES (?1, CAST(?2 AS REAL))
     ON CONFLICT (period) DO UPDATE SET amount = amount + excluded.amount
     WHERE amount + excluded.amount <= CAST(?3 AS REAL)
     RETURNING amount`,
  )
    .bind(period, amount, limit)
    .first();
  return row ? row.amount : null;
}

const refund = (env, period, amount) =>
  env.USAGE.prepare("UPDATE usage SET amount = MAX(0, amount - ?2) WHERE period = ?1").bind(period, amount).run();

async function readUsage(env) {
  const p = periods();
  const { results } = await env.USAGE.prepare("SELECT period, amount FROM usage WHERE period IN (?1, ?2)")
    .bind(p.neurons, p.images)
    .all();
  const get = (k) => results.find((r) => r.period === k)?.amount || 0;
  const l = limits(env);
  return {
    neurons_today: Math.round(get(p.neurons)),
    neuron_daily_limit: l.neurons,
    background_removals_this_month: get(p.images),
    background_removal_monthly_limit: l.images,
    resets: "neurons at 00:00 UTC daily; background removals on the 1st of each month (UTC)",
  };
}

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
  if (!env.USAGE) {
    return json({ error: "USAGE (D1) binding is missing; generation is disabled so spend can't be capped." }, 503);
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

  const steps = model.steps
    ? clampInt(form.get("steps"), model.steps.min, model.steps.max, model.steps.default)
    : null;
  const w = model.size ? snapSize(form.get("width")) : 1024;
  const h = model.size ? snapSize(form.get("height")) : 1024;
  const ref = form.get("ref");
  const hasRef = Boolean(model.ref && ref && typeof ref !== "string" && ref.size > 0);

  const p = periods();
  const lim = limits(env);
  const neurons = Math.ceil(model.cost({ w, h, steps, ref: hasRef }));
  if ((await reserve(env, p.neurons, neurons, lim.neurons)) === null) {
    return json(
      {
        error: `Daily Workers AI budget reached: this request needs ~${neurons} neurons. Resets at 00:00 UTC.`,
        estimated_neurons: neurons,
        usage: await readUsage(env),
      },
      429,
    );
  }

  const started = Date.now();
  let result;

  try {
    if (!model.multipart) {
      // FLUX.1 [schnell]: plain JSON input
      const input = { prompt, steps };
      if (seed !== null) input.seed = seed;
      result = await env.AI.run(model.id, input);
    } else {
      // FLUX.2 models: multipart input, even for prompt-only requests
      const body = new FormData();
      body.append("prompt", prompt);
      body.append("width", String(w));
      body.append("height", String(h));
      if (steps !== null) body.append("steps", String(steps));
      if (seed !== null) body.append("seed", String(seed));

      if (hasRef) {
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
    await refund(env, p.neurons, neurons);
    return json({ error: `Model call failed: ${err?.message || err}` }, 502);
  }

  const image = result?.image;
  if (!image) return json({ error: "Model returned no image.", raw: result }, 502);

  const meta = { model: key, prompt, transparent: false, estimated_neurons: neurons };
  if (transparent) {
    if ((await reserve(env, p.images, 1, lim.images)) === null) {
      meta.warning = "Monthly background-removal budget reached; returning the opaque image.";
    } else {
      try {
        const cutout = await removeBackground(env, image);
        meta.transparent = true;
        return json({ image: cutout, mime: "image/png", ...meta, ms: Date.now() - started });
      } catch (err) {
        console.error("Background removal failed", err);
        await refund(env, p.images, 1);
        meta.warning = `Background removal failed, returning the opaque image: ${err?.message || err}`;
      }
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
          neurons_at_1024: Math.ceil(m.cost({ w: 1024, h: 1024, steps: m.steps?.default, ref: false })),
        })),
      );
    }

    if (request.method === "GET" && pathname === "/usage") {
      if (!env.USAGE) return json({ error: "USAGE (D1) binding is missing." }, 503);
      return json(await readUsage(env));
    }

    if (request.method === "POST" && pathname === "/generate") {
      return generate(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};
