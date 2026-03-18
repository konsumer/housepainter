import { useState } from "react";

const keys = {
  localhost: "pk_54ttiop5dFTBOSTM",
  "konsumer.js.org": "pk_iFXgqInBzld9zPSu",
};

const params = new URLSearchParams({
  redirect_url: window.location.toString(),
  app_key: keys[window.location.hostname],
});

export default function App() {
  const [imageIn, imageInSet] = useState();
  const [colorIn, colorInSet] = useState("#ffffff");
  const [imageOut, imageOutSet] = useState();
  const [painting, paintingSet] = useState();

  if (!localStorage.polykey) {
    return (
      <div className="p-8">
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
      imageInSet(URL.createObjectURL(target.files[0]));
    }
  };

  const handlePaint = async () => {
    paintingSet(true);
    const formData = new FormData();
    formData.append(
      "prompt",
      `I want this exact house, from the same angle and everything, but painted the color ${colorIn}`,
    );
    formData.append("model", "flux-2");

    const response = await fetch(imageIn);
    const blob = await response.blob();
    formData.append("image", blob, "house.jpg");

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

    const {
      data: [{ b64_json }],
    } = editResponse;
    console.log(editResponse);
    imageOutSet(`data:image/jpeg;base64,${b64_json}`);
    paintingSet(false);
  };

  return (
    <div className="p-8 flex flex-col gap-4">
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
            <img src={imageIn} alt="Your house" className="max-w-md" />
          </div>
          <div className="flex flex-col gap-1">
            <div>Choose what color you want to paint it</div>
            <div>
              <input
                type="color"
                value={colorIn}
                onChange={(e) => colorInSet(e.target.value)}
                className="input"
              />
            </div>
          </div>
          <div>
            <button
              onClick={handlePaint}
              disabled={painting}
              className="btn btn-primary"
            >
              {painting ? "Painting..." : "PAINT"}
            </button>
          </div>
          {imageOut && (
            <div>
              <img src={imageOut} alt="Painted house" className="max-w-md" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
