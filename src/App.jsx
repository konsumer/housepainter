import { useState } from "react";

const MODEL = "flux-2-dev";
// const MODEL = "gptimage";
// const MODEL = "zimage";

const keys = {
  localhost: "pk_35eJsWPDu2YQAeeW",
  "konsumer.js.org": "pk_5We7AuOGT3bdejcK",
};

const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";

const params = new URLSearchParams({
  redirect_url: window.location.toString(),
  app_key: keys[window.location.hostname],
});

const SCHEME_MODES = [
  { value: "analogic", label: "Analogic" },
  { value: "analogic-complement", label: "Analogic Complement" },
  { value: "triad", label: "Triad" },
  { value: "complement", label: "Complement" },
  { value: "monochrome", label: "Monochrome" },
];

async function fetchPalette(hex, mode) {
  const clean = hex.replace("#", "");
  const res = await fetch(
    `https://www.thecolorapi.com/scheme?hex=${clean}&mode=${mode}&count=3`,
  );
  const data = await res.json();
  return data.colors.map((c) => ({
    hex: c.hex.value,
    name: c.name.value,
  }));
}

function ColorSwatch({ color, label }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="w-16 h-16 rounded border-2 border-base-content/30 shadow-lg"
        style={{ background: color.hex }}
        title={color.name}
      />
      <div className="badge badge-outline text-xs">{label}</div>
      <div className="text-xs font-mono font-bold">{color.hex}</div>
      <div className="text-xs text-center text-base-content/60 max-w-16 leading-tight">
        {color.name}
      </div>
    </div>
  );
}

function HouseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="w-10 h-10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
      <path d="M9 21V12h6v9" />
    </svg>
  );
}

function buildSinglePrompt(color) {
  return `I want this house, repainted the color ${color}`;
}

function buildPalettePrompt(palette) {
  if (!palette) return "";
  const [primary, secondary, trim] = palette;
  return `I want this house, repainted with this color scheme: primary walls in ${primary.hex} (${primary.name}), secondary surfaces in ${secondary.hex} (${secondary.name}), and trim/accents in ${trim.hex} (${trim.name})`;
}

export default function App() {
  const [imageIn, imageInSet] = useState();
  const [imageFile, imageFileSet] = useState();

  // mode: "single" | "palette"
  const [colorMode, colorModeSet] = useState("single");

  // single color
  const [colorIn, colorInSet] = useState("#4a7c59");

  // palette mode
  const [seedColor, seedColorSet] = useState("#4a7c59");
  const [schemeMode, schemeModeSet] = useState("analogic");
  const [palette, paletteSet] = useState(null);
  const [loadingPalette, loadingPaletteSet] = useState(false);

  const [imageOut, imageOutSet] = useState();
  const [painting, paintingSet] = useState();

  const [primaryPrompt, primaryPromptSet] = useState(buildSinglePrompt("#4a7c59"));
  const [additionalPrompt, additionalPromptSet] = useState("");

  const [error, errorSet] = useState("");

  if (!localStorage.polykey) {
    return (
      <div
        data-theme="cyberpunk"
        className="min-h-screen bg-base-200 flex items-center justify-center p-6"
      >
        <div className="card w-full max-w-md bg-base-100 card-neon">
          <div className="card-body items-center text-center gap-6">
            <div className="text-primary">
              <HouseIcon />
            </div>
            <div>
              <h1 className="card-title text-3xl font-black tracking-tight justify-center text-primary">
                HOUSEPAINTER
              </h1>
              <p className="text-base-content/50 text-sm mt-1 font-mono">
                AI-powered exterior color visualizer
              </p>
            </div>
            <div className="divider divider-primary my-0 opacity-30" />
            <p className="text-base-content/70 leading-relaxed">
              Upload a photo of your house and see how it looks in any color —
              powered by AI image editing.
            </p>
            <div className="card-actions w-full">
              <a
                href={`https://enter.pollinations.ai/authorize?${params}`}
                className="btn btn-primary w-full"
              >
                Connect with Pollinations
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleImageUpload = ({ target }) => {
    if (target?.files?.length) {
      imageFileSet(target.files[0]);
      // Revoke old blob URLs to avoid memory leaks
      if (imageIn?.startsWith("blob:")) URL.revokeObjectURL(imageIn);
      if (imageOut?.startsWith("blob:")) URL.revokeObjectURL(imageOut);
      imageInSet(URL.createObjectURL(target.files[0]));
      imageOutSet(undefined);
    }
  };

  const handleFetchPalette = async () => {
    loadingPaletteSet(true);
    try {
      const colors = await fetchPalette(seedColor, schemeMode);
      paletteSet(colors);
      primaryPromptSet(buildPalettePrompt(colors));
    } finally {
      loadingPaletteSet(false);
    }
  };

  const handlePaint = async () => {
    paintingSet(true);
    errorSet("");

    const fullPrompt = (primaryPrompt + " " + additionalPrompt).trim();

    try {
      // Step 1: Upload the image to litterbox.catbox.moe for a temporary public URL.
      // flux-2-dev (and similar community-provider models) need a public image URL
      // rather than a multipart file upload.
      const uploadForm = new FormData();
      uploadForm.append("reqtype", "fileupload");
      uploadForm.append("time", "1h");
      uploadForm.append("fileToUpload", imageFile, imageFile.name);

      const uploadRes = await fetch(LITTERBOX_API, {
        method: "POST",
        body: uploadForm,
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed (${uploadRes.status})`);
      }

      const imageUrl = (await uploadRes.text()).trim();
      if (!imageUrl.startsWith("https://")) {
        throw new Error(`Unexpected upload response: ${imageUrl}`);
      }

      // Step 2: Call the pollinations GET endpoint with the image URL.
      // This is the same approach their "play" UI uses and works correctly
      // with flux-2-dev which ignores multipart uploads via /v1/images/edits.
      const pollinationsParams = new URLSearchParams({
        model: MODEL,
        width: "1024",
        height: "1024",
        seed: "-1",
        enhance: "false",
        image: imageUrl,
        key: localStorage.polykey,
      });

      const encodedPrompt = encodeURIComponent(fullPrompt);
      const genUrl = `https://gen.pollinations.ai/image/${encodedPrompt}?${pollinationsParams}`;

      const imgRes = await fetch(genUrl);
      if (!imgRes.ok) {
        throw new Error(`Generation failed (${imgRes.status})`);
      }

      // Response is a raw image binary (image/jpeg or image/png)
      const blob = await imgRes.blob();
      imageOutSet(URL.createObjectURL(blob));
    } catch (err) {
      errorSet(err.message || "Unknown error");
    }

    paintingSet(false);
  };

  const canPaint =
    imageIn &&
    !painting &&
    (colorMode === "single" || (colorMode === "palette" && palette));

  return (
    <div data-theme="cyberpunk" className="min-h-screen bg-base-200">
      {/* Header */}
      <div
        className="navbar bg-base-100 border-b border-primary/40 px-6"
        style={{
          boxShadow:
            "0 1px 20px -4px color-mix(in oklch, var(--color-primary) 40%, transparent)",
        }}
      >
        <div className="flex items-center gap-3 text-primary">
          <HouseIcon />
          <div>
            <span className="text-xl font-black tracking-tight">
              HOUSEPAINTER
            </span>
            <span className="text-xs text-base-content/40 block leading-none">
              AI color visualizer
            </span>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto flex flex-col gap-6">
        {/* Upload card */}
        <div className="card bg-base-100 card-neon">
          <div className="card-body gap-4">
            <h2 className="card-title text-lg text-primary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              Upload Your House Photo
            </h2>
            <input
              type="file"
              className="file-input file-input-primary w-full"
              onChange={handleImageUpload}
              accept="image/*"
            />
          </div>
        </div>

        {imageIn && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left column: controls */}
            <div className="flex flex-col gap-4">
              {/* Color mode toggle */}
              <div className="card bg-base-100 card-neon">
                <div className="card-body gap-3">
                  <h2 className="card-title text-base text-primary">
                    Color Mode
                  </h2>
                  <div className="flex w-full gap-2">
                    <button
                      className={`btn flex-1 ${colorMode === "single" ? "btn-primary" : "btn-ghost border border-primary/30"}`}
                      onClick={() => {
                        colorModeSet("single");
                        primaryPromptSet(buildSinglePrompt(colorIn));
                      }}
                    >
                      Single Color
                    </button>
                    <button
                      className={`btn flex-1 ${colorMode === "palette" ? "btn-primary" : "btn-ghost border border-primary/30"}`}
                      onClick={() => {
                        colorModeSet("palette");
                        primaryPromptSet(buildPalettePrompt(palette));
                      }}
                    >
                      Palette
                    </button>
                  </div>

                  {/* Single color picker */}
                  {colorMode === "single" && (
                    <div className="flex items-center gap-4 pt-1">
                      <label className="text-sm text-base-content/70 font-medium">
                        Paint color
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={colorIn}
                          onChange={(e) => {
                            colorInSet(e.target.value);
                            primaryPromptSet(buildSinglePrompt(e.target.value));
                          }}
                          className="w-12 h-10 rounded cursor-pointer border border-base-content/20 bg-transparent p-0.5"
                        />
                        <span className="font-mono text-sm">
                          {colorIn.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Palette mode */}
                  {colorMode === "palette" && (
                    <div className="flex flex-col gap-3 pt-1">
                      <div className="flex items-center gap-4">
                        <label className="text-sm text-base-content/70 font-medium">
                          Seed color
                        </label>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            value={seedColor}
                            onChange={(e) => {
                              seedColorSet(e.target.value);
                              paletteSet(null);
                              primaryPromptSet("");
                            }}
                            className="w-12 h-10 rounded cursor-pointer border border-base-content/20 bg-transparent p-0.5"
                          />
                          <span className="font-mono text-sm">
                            {seedColor.toUpperCase()}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-sm text-base-content/70 font-medium">
                          Scheme style
                        </label>
                        <select
                          className="select select-bordered select-sm"
                          value={schemeMode}
                          onChange={(e) => {
                            schemeModeSet(e.target.value);
                            paletteSet(null);
                            primaryPromptSet("");
                          }}
                        >
                          {SCHEME_MODES.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <button
                        className="btn btn-accent btn-sm"
                        onClick={handleFetchPalette}
                        disabled={loadingPalette}
                      >
                        {loadingPalette && (
                          <span className="loading loading-spinner w-4 h-4" />
                        )}
                        {loadingPalette ? "Fetching…" : "Generate Palette"}
                      </button>

                      {palette && (
                        <div className="flex justify-around items-start pt-2 border-t border-base-content/10">
                          <ColorSwatch color={palette[0]} label="Primary" />
                          <ColorSwatch color={palette[1]} label="Secondary" />
                          <ColorSwatch color={palette[2]} label="Trim" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Primary prompt */}
              <div className="card bg-base-100 card-neon">
                <div className="card-body gap-2">
                  <h2 className="card-title text-base text-primary">
                    Prompt
                  </h2>
                  <textarea
                    value={primaryPrompt}
                    onChange={(e) => primaryPromptSet(e.target.value)}
                    className="textarea textarea-bordered w-full resize-none"
                    placeholder="Describe what you want the AI to do…"
                    rows={4}
                  />
                </div>
              </div>

              {/* Additional prompt */}
              <div className="card bg-base-100 card-neon">
                <div className="card-body gap-2">
                  <h2 className="card-title text-base text-primary">
                    Additional Instructions
                  </h2>
                  <textarea
                    value={additionalPrompt}
                    onChange={(e) => additionalPromptSet(e.target.value)}
                    className="textarea textarea-bordered w-full resize-none"
                    placeholder="e.g. keep the shutters dark, make the door red…"
                    rows={3}
                  />
                </div>
              </div>

              {/* Error */}
              {error && (
                <div role="alert" className="alert alert-error">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5 shrink-0 stroke-current"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              {/* Paint button */}
              <button
                onClick={handlePaint}
                disabled={!canPaint}
                className="btn btn-primary btn-lg w-full"
              >
                {painting && (
                  <span className="loading loading-spinner w-5 h-5" />
                )}
                {painting ? "Painting…" : "Paint My House"}
              </button>
              {colorMode === "palette" && !palette && (
                <p className="text-xs text-base-content/40 text-center -mt-2">
                  Generate a palette first
                </p>
              )}
            </div>

            {/* Right column: images */}
            <div className="flex flex-col gap-4">
              <div className="card bg-base-100 card-neon">
                <div className="card-body gap-3 p-4">
                  <h2 className="card-title text-base text-primary">
                    Original
                  </h2>
                  <img
                    src={imageIn}
                    alt="Your house"
                    className="rounded w-full object-cover"
                  />
                </div>
              </div>

              {imageOut && (
                <div className="card bg-base-100 card-neon-result">
                  <div className="card-body gap-3 p-4">
                    <h2 className="card-title text-base text-secondary">
                      Result
                    </h2>
                    <img
                      src={imageOut}
                      alt="Painted house"
                      className="rounded w-full object-cover"
                    />
                    <a
                      href={imageOut}
                      download="painted-house.jpg"
                      className="btn btn-outline btn-primary btn-sm"
                    >
                      Download
                    </a>
                  </div>
                </div>
              )}

              {painting && (
                <div className="card bg-base-100 card-neon">
                  <div className="card-body items-center gap-4 py-10">
                    <span className="loading loading-ring loading-lg text-primary" />
                    <p className="text-base-content/50 text-sm">
                      AI is painting your house…
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
