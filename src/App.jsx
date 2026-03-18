import { useState } from "react";

const MODEL = "gptimage";
// const MODEL = "zimage";

const keys = {
  localhost: "pk_35eJsWPDu2YQAeeW",
  "konsumer.js.org": "pk_5We7AuOGT3bdejcK",
};

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
    <div className="flex flex-col items-center gap-1">
      <div
        className="w-12 h-12 rounded border border-base-300 shadow"
        style={{ background: color.hex }}
        title={color.name}
      />
      <div className="text-xs text-base-content/60">{label}</div>
      <div className="text-xs font-mono">{color.hex}</div>
      <div className="text-xs text-center text-base-content/50">
        {color.name}
      </div>
    </div>
  );
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

  const [additionalPrompt, additionalPromptSet] = useState("");

  const [error, errorSet] = useState("");

  if (!localStorage.polykey) {
    return (
      <div className="p-8">
        <p>
          This will allow you to see what your house looks like, in different
          colors.
        </p>
        <a
          href={`https://enter.pollinations.ai/authorize?${params}`}
          className="btn btn-primary"
        >
          Login
        </a>
      </div>
    );
  }

  const handleImageUpload = ({ target }) => {
    if (target?.files?.length) {
      imageFileSet(target.files[0]);
      imageInSet(URL.createObjectURL(target.files[0]));
    }
  };

  const handleFetchPalette = async () => {
    loadingPaletteSet(true);
    try {
      const colors = await fetchPalette(seedColor, schemeMode);
      paletteSet(colors);
    } finally {
      loadingPaletteSet(false);
    }
  };

  const handlePaint = async () => {
    paintingSet(true);
    errorSet("");

    let prompt;
    if (colorMode === "single") {
      prompt = `I want this house, repainted the color ${colorIn}`;
    } else {
      const [primary, secondary, trim] = palette;
      prompt = `I want this house, repainted with this color scheme: primary walls in ${primary.hex} (${primary.name}), secondary surfaces in ${secondary.hex} (${secondary.name}), and trim/accents in ${trim.hex} (${trim.name})`;
    }

    const formData = new FormData();
    formData.append("prompt", (prompt + " " + additionalPrompt).trim());
    formData.append("model", MODEL);
    formData.append("image", imageFile, imageFile.name);

    const editResponse = await fetch(
      "https://gen.pollinations.ai/v1/images/edits",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.polykey}`,
        },
        body: formData,
      },
    ).then((r) => r.json());

    if (editResponse?.error) {
      errorSet(editResponse?.error?.message);
    } else {
      const {
        data: [{ b64_json }],
      } = editResponse;
      imageOutSet(`data:image/jpeg;base64,${b64_json}`);
    }
    paintingSet(false);
  };

  const canPaint =
    imageIn &&
    !painting &&
    (colorMode === "single" || (colorMode === "palette" && palette));

  return (
    <div className="p-8 flex flex-col gap-6 max-w-2xl">
      <div className="flex flex-col gap-1">
        <div>Upload an image of your house</div>
        <div>
          <input
            type="file"
            className="file-input file-input-primary"
            onChange={handleImageUpload}
            accept="image/*"
          />
        </div>
      </div>

      {imageIn && (
        <>
          <div>
            <img
              src={imageIn}
              alt="Your house"
              className="max-w-md rounded shadow"
            />
          </div>

          {/* Mode toggle */}
          <div className="flex flex-col gap-2">
            <div className="font-medium">Color mode</div>
            <div className="join">
              <button
                className={`join-item btn btn-sm ${colorMode === "single" ? "btn-primary" : "btn-outline"}`}
                onClick={() => colorModeSet("single")}
              >
                Single Color
              </button>
              <button
                className={`join-item btn btn-sm ${colorMode === "palette" ? "btn-primary" : "btn-outline"}`}
                onClick={() => colorModeSet("palette")}
              >
                Palette
              </button>
            </div>
          </div>

          {/* Single color */}
          {colorMode === "single" && (
            <div className="flex flex-col gap-1">
              <div>Choose a paint color</div>
              <input
                type="color"
                value={colorIn}
                onChange={(e) => colorInSet(e.target.value)}
                className="input w-16 h-10 p-1 cursor-pointer"
              />
            </div>
          )}

          {/* Palette mode */}
          {colorMode === "palette" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <div>Seed color</div>
                <input
                  type="color"
                  value={seedColor}
                  onChange={(e) => {
                    seedColorSet(e.target.value);
                    paletteSet(null);
                  }}
                  className="input w-16 h-10 p-1 cursor-pointer"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div>Color scheme style</div>
                <select
                  className="select select-bordered select-sm w-48"
                  value={schemeMode}
                  onChange={(e) => {
                    schemeModeSet(e.target.value);
                    paletteSet(null);
                  }}
                >
                  {SCHEME_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={handleFetchPalette}
                  disabled={loadingPalette}
                >
                  {loadingPalette ? "Fetching..." : "Generate Palette"}
                </button>
              </div>

              {palette && (
                <div className="flex gap-6 items-start">
                  <ColorSwatch color={palette[0]} label="Primary" />
                  <ColorSwatch color={palette[1]} label="Secondary" />
                  <ColorSwatch color={palette[2]} label="Trim" />
                </div>
              )}
              <textarea
                value={additionalPrompt}
                onChange={(e) => additionalPromptSet(e.target.value)}
                className="textarea"
                placeholder="Additional prompt"
              ></textarea>
            </div>
          )}

          {error && (
            <div role="alert" className="alert alert-error">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6 shrink-0 stroke-current"
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

          <div className="flex items-center gap-3">
            <button
              onClick={handlePaint}
              disabled={!canPaint}
              className="btn btn-primary"
            >
              {painting ? "Painting..." : "PAINT"}
            </button>
            {colorMode === "palette" && !palette && (
              <span className="text-sm text-base-content/50">
                Generate a palette first
              </span>
            )}
          </div>

          {imageOut && (
            <img
              src={imageOut}
              alt="Painted house"
              className="w-full rounded shadow"
            />
          )}
        </>
      )}
    </div>
  );
}
