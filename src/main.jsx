import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

if (window?.location?.hash?.startsWith("#api_key=")) {
  const hash = window.location.hash.toString();
  localStorage.polykey = hash.replace("#api_key=", "");
  window.location = window.location.toString().replace(hash, "");
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
