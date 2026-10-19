import PAGE from "./page.html";

/**
 * FLUX image API on Cloudflare Workers AI, built to be called by people (the UI at /) or by AI agents.
 *
 * GET  /          -> web UI
 * GET  /api       -> machine-readable description: fields, scenarios, styles, model, costs (start here)
 * GET  /usage     -> today's Workers AI neurons and this month's Images transformations vs. the caps
 * POST /generate  -> multipart/form-data or application/json:
 *                      prompt       (required)
 *                      scenario     preset from /api (icon, game-asset, character, texture, ...); default custom
 *                      style        art style from /api (low-poly, pixel-art, ...); default none
 *                      width/height multiples of 16 in 256..1536; default from the scenario
 *                      transparent  true/false; default from the scenario
 *                      seed         integer, for repeatable results
 *                      ref          reference image (file field, or base64 / data URL in JSON); required by `edit`
 *                    returns JSON { image (base64), mime, model, scenario, style, width, height, transparent,
 *                                   prompt, estimated_neurons, ms, notes?, warning? }
 *
 * Model is locked to FLUX.2 [klein] 4B (fixed 4 steps) to keep cost predictable; `model` and `steps`
 * from callers are ignored and reported in `notes`.
 *
 * FLUX can't output alpha; asked for "transparent" it paints a checkerboard. So with transparent on, the
 * Worker strips that wording, asks for a plain background, then cuts the subject out with the Images
 * binding (segment: "foreground"). If the cut-out can't run, the opaque image comes back with `warning`.
 * Reference images of 512 px or more are downscaled with the Images binding (FLUX.2 needs < 512x512).
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

// Neuron estimate from https://developers.cloudflare.com/workers-ai/platform/pricing/
// (tiles are 512x512, rounded up; plus one input tile when a reference image is sent).
const tiles = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);

const MODEL = {
  key: "flux-2-klein-4b",
  id: "@cf/black-forest-labs/flux-2-klein-4b",
  label: "FLUX.2 [klein] 4B (fixed 4 steps)",
  cost: ({ w, h, ref }) => Math.ceil(26.05 * tiles(w, h) + (ref ? 5.37 : 0)),
};

const STYLES = {
  none: { label: "None", text: "" },
  "low-poly": { label: "Low-poly", text: "low-poly 3D style, flat-shaded facets, simple geometry" },
  "pixel-art": { label: "Pixel art", text: "pixel art, crisp pixels, limited color palette, retro game style" },
  "flat-vector": { label: "Flat vector", text: "flat vector illustration, clean shapes, solid colors, no gradients" },
  cartoon: { label: "Cartoon", text: "stylized cartoon, bold outlines, vibrant colors" },
  "hand-painted": { label: "Hand-painted", text: "hand-painted stylized game art, painterly brush strokes" },
  anime: { label: "Anime", text: "anime style, cel shading, clean line art" },
  "3d-render": { label: "3D render", text: "high quality 3D render, soft studio lighting, subtle ambient occlusion" },
  realistic: { label: "Realistic", text: "photorealistic, physically based materials, natural lighting" },
};

// Each scenario wraps the caller's prompt and sets defaults; explicit request fields always win.
const SCENARIOS = {
  custom: {
    label: "Custom",
    description: "Your prompt exactly as written.",
    template: "{prompt}",
    defaults: { width: 1024, height: 1024, transparent: false },
  },
  icon: {
    label: "Icon / emblem",
    description: "Single centered game or UI icon with a bold silhouette. Transparent by default.",
    template: "{prompt}, game UI icon, single centered emblem, bold readable silhouette, clean edges",
    defaults: { width: 1024, height: 1024, transparent: true },
  },
  "game-asset": {
    label: "Game asset / prop",
    description: "One object or prop, three-quarter view, whole object in frame. Transparent by default.",
    template: "{prompt}, single game asset, three-quarter isometric view, entire object in frame, clean readable shapes",
    defaults: { width: 1024, height: 1024, transparent: true },
  },
  character: {
    label: "Character concept",
    description: "Full-body character, front view, portrait frame. Transparent by default.",
    template: "{prompt}, full-body character concept art, front view, neutral pose, entire figure in frame",
    defaults: { width: 832, height: 1216, transparent: true },
  },
  texture: {
    label: "Seamless texture",
    description: "Tileable top-down surface texture (ground, wall, fabric...).",
    template: "{prompt}, seamless tileable texture, top-down orthographic view, even flat lighting, no shadows, no perspective",
    defaults: { width: 1024, height: 1024, transparent: false },
  },
  environment: {
    label: "Environment / concept art",
    description: "Wide scene or location concept, landscape frame.",
    template: "{prompt}, environment concept art, wide establishing shot, atmospheric depth",
    defaults: { width: 1216, height: 832, transparent: false },
  },
  thumbnail: {
    label: "Thumbnail / banner",
    description: "Eye-catching 16:9 promo image for a game page or video.",
    template: "{prompt}, eye-catching game thumbnail, dynamic composition, vibrant colors, high contrast",
    defaults: { width: 1536, height: 864, transparent: false },
  },
  logo: {
    label: "Logo / title text",
    description: "Logo or title lettering. Put the exact words in quotes in the prompt. Transparent by default.",
    template: "{prompt}, logo design, bold clean typography, simple shapes, centered",
    defaults: { width: 1024, height: 1024, transparent: true },
  },
  photo: {
    label: "Product photo",
    description: "Photorealistic studio product shot.",
    template: "{prompt}, professional product photography, studio lighting, sharp focus",
    defaults: { width: 1024, height: 1024, transparent: false },
  },
  edit: {
    label: "Edit reference image",
    description: "Change or restyle an uploaded image. Requires `ref`; refer to it as \"image 0\" in the prompt.",
    template: "{prompt}",
    defaults: { width: 1024, height: 1024, transparent: false },
    requiresRef: true,
  },
};

const DEFAULT_NEURON_DAILY_LIMIT = 9500;
const DEFAULT_IMAGES_MONTHLY_LIMIT = 4900;
const MAX_REF_BYTES = 10 * 1024 * 1024;

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
    images_transformations_this_month: get(p.images),
    images_transformations_monthly_limit: l.images,
    resets: "neurons at 00:00 UTC daily; Images transformations on the 1st of each month (UTC)",
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
const snapSize = (value, fallback) => {
  const n = clampInt(value, 256, 1536, fallback);
  return Math.round(n / 16) * 16;
};

// true / false / null (not given), from form strings or JSON booleans
const parseBool = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no"].includes(s)) return false;
  return null;
};

const TRANSPARENCY_WORDS =
  /[,;]?\s*\b(?:(?:on|with|in)\s+(?:an?\s+)?)?(?:transparen\w*|alpha|checker(?:ed|board)?)(?:\s+(?:background|backgroud|bg))?\b|\bpng\b/gi;
const PLAIN_BACKGROUND =
  "centered, isolated subject on a plain flat solid-color background, no shadow, no checkerboard pattern";

const tidy = (text) =>
  text.replace(/\s+([,;])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "").trim();

// Scenario template + style, then (for transparent) swap transparency wording for a plain background.
const buildPrompt = (raw, scenario, style, transparent) => {
  const subject = transparent ? tidy(raw.replace(TRANSPARENCY_WORDS, "")) || raw : raw;
  let prompt = scenario.template.replace("{prompt}", subject);
  if (style.text) prompt += `, ${style.text}`;
  if (transparent) prompt += `, ${PLAIN_BACKGROUND}`;
  return prompt;
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

async function shrinkRef(env, blob) {
  const output = await env.IMAGES.input(blob.stream())
    .transform({ width: 496, height: 496, fit: "scale-down" })
    .output({ format: "image/png" });
  return output.response().blob();
}

const sniffMime = (b64) => {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
};

// Accept multipart/form-data (UI, curl -F) or application/json (agents). Returns { get, ref }.
async function readInput(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error("JSON body must be an object.");
    let ref = null;
    if (typeof body.ref === "string" && body.ref) {
      const b64 = body.ref.replace(/^data:[^,]*,/, "");
      if (b64.length > (MAX_REF_BYTES * 4) / 3) throw new Error("ref is larger than 10 MB.");
      ref = new Blob([base64ToBytes(b64)]);
    }
    return { get: (k) => body[k] ?? null, ref };
  }
  const form = await request.formData();
  const ref = form.get("ref");
  return {
    get: (k) => form.get(k),
    ref: ref && typeof ref !== "string" && ref.size > 0 ? ref : null,
  };
}

function apiDescription() {
  return {
    endpoint: "POST /generate",
    auth: "header x-access-key",
    content_types: ["application/json", "multipart/form-data"],
    model: { key: MODEL.key, label: MODEL.label, locked: true, steps: 4 },
    fields: {
      prompt: "string, required, max 2048 chars. Describe the subject; the scenario adds the framing.",
      scenario: `one of: ${Object.keys(SCENARIOS).join(", ")} (default custom)`,
      style: `one of: ${Object.keys(STYLES).join(", ")} (default none)`,
      width: "integer 256-1536, snapped to a multiple of 16 (default from scenario)",
      height: "integer 256-1536, snapped to a multiple of 16 (default from scenario)",
      transparent: "boolean: true returns a PNG with the background removed (default from scenario)",
      seed: "integer, optional, for repeatable results",
      ref: "optional reference image: file field (multipart) or base64 / data URL string (JSON). Refer to it as \"image 0\".",
    },
    scenarios: Object.entries(SCENARIOS).map(([key, s]) => ({
      key,
      label: s.label,
      description: s.description,
      defaults: s.defaults,
      requires_ref: Boolean(s.requiresRef),
      estimated_neurons: MODEL.cost({ w: s.defaults.width, h: s.defaults.height, ref: Boolean(s.requiresRef) }),
    })),
    styles: Object.entries(STYLES).map(([key, s]) => ({ key, label: s.label })),
    response:
      "JSON { image: base64, mime, model, scenario, style, width, height, transparent, prompt, estimated_neurons, ms, notes?, warning? }",
    errors: {
      400: "bad input (message says which field)",
      401: "missing or wrong x-access-key",
      429: "daily neuron budget reached; see `usage`, resets 00:00 UTC",
      502: "model call failed",
      503: "Worker not configured (ACCESS_KEY or USAGE binding missing)",
    },
    example: {
      prompt: "flaming sword",
      scenario: "game-asset",
      style: "low-poly",
      transparent: true,
    },
  };
}

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

  let input;
  try {
    input = await readInput(request);
  } catch (err) {
    return json({ error: `Could not read request: ${err?.message || err}. Send JSON or multipart/form-data.` }, 400);
  }
  const { get } = input;
  let ref = input.ref;

  const rawPrompt = String(get("prompt") || "").trim();
  if (!rawPrompt) return json({ error: "prompt is required." }, 400);
  if (rawPrompt.length > 2048) return json({ error: "prompt is longer than 2048 characters." }, 400);

  const scenarioKey = String(get("scenario") || "custom");
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    return json({ error: `Unknown scenario "${scenarioKey}". Use one of: ${Object.keys(SCENARIOS).join(", ")}.` }, 400);
  }
  const styleKey = String(get("style") || "none");
  const style = STYLES[styleKey];
  if (!style) {
    return json({ error: `Unknown style "${styleKey}". Use one of: ${Object.keys(STYLES).join(", ")}.` }, 400);
  }
  if (scenario.requiresRef && !ref) {
    return json({ error: `Scenario "${scenarioKey}" needs a reference image in \`ref\`.` }, 400);
  }
  if (ref && ref.size > MAX_REF_BYTES) return json({ error: "ref is larger than 10 MB." }, 400);

  const notes = [];
  const askedModel = get("model");
  if (askedModel && String(askedModel) !== MODEL.key) {
    notes.push(`model is locked to ${MODEL.key}; requested "${askedModel}" was ignored.`);
  }
  if (get("steps") !== null && get("steps") !== "") notes.push("steps are fixed at 4; requested steps were ignored.");

  const transparent = parseBool(get("transparent")) ?? scenario.defaults.transparent;
  const w = snapSize(get("width"), scenario.defaults.width);
  const h = snapSize(get("height"), scenario.defaults.height);
  const seedRaw = get("seed");
  const seed = seedRaw === null || seedRaw === "" ? null : clampInt(seedRaw, 0, 2147483647, null);
  const prompt = buildPrompt(rawPrompt, scenario, style, transparent);

  const p = periods();
  const lim = limits(env);

  // FLUX.2 needs reference images under 512x512; downscale bigger ones (counts as an Images transformation).
  if (ref) {
    let info;
    try {
      info = await env.IMAGES.info(ref.stream());
    } catch (err) {
      return json({ error: `ref is not a readable image: ${err?.message || err}` }, 400);
    }
    if (info.width >= 512 || info.height >= 512) {
      if ((await reserve(env, p.images, 1, lim.images)) === null) {
        return json({ error: "ref must be under 512x512: the monthly Images budget for resizing is used up." }, 400);
      }
      try {
        ref = await shrinkRef(env, ref);
        notes.push(`ref was downscaled from ${info.width}x${info.height} to fit 496 px.`);
      } catch (err) {
        await refund(env, p.images, 1);
        return json({ error: `Could not downscale ref; send one under 512x512. (${err?.message || err})` }, 400);
      }
    }
  }

  const neurons = MODEL.cost({ w, h, ref: Boolean(ref) });
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
    // FLUX.2 takes multipart input, even for prompt-only requests
    const body = new FormData();
    body.append("prompt", prompt);
    body.append("width", String(w));
    body.append("height", String(h));
    if (seed !== null) body.append("seed", String(seed));
    if (ref) body.append("input_image_0", ref, "ref.png");

    // Serialising through Response gives us the stream + boundary header.
    const packed = new Response(body);
    result = await env.AI.run(MODEL.id, {
      multipart: { body: packed.body, contentType: packed.headers.get("content-type") },
    });
  } catch (err) {
    console.error("AI.run failed", err);
    await refund(env, p.neurons, neurons);
    return json({ error: `Model call failed: ${err?.message || err}` }, 502);
  }

  const image = result?.image;
  if (!image) return json({ error: "Model returned no image.", raw: result }, 502);

  const meta = {
    model: MODEL.key,
    scenario: scenarioKey,
    style: styleKey,
    width: w,
    height: h,
    transparent: false,
    prompt,
    estimated_neurons: neurons,
  };
  if (notes.length) meta.notes = notes;

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

    if (request.method === "GET" && pathname === "/api") {
      return json(apiDescription());
    }

    if (request.method === "GET" && pathname === "/models") {
      return json([{ key: MODEL.key, label: MODEL.label, locked: true }]);
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
