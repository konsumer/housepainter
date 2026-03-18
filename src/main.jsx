import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

if (window?.location?.hash?.startsWith("#api_key=")) {
  localStorage.polykey = window.location.hash.replace("#api_key=", "");
  window.location = window.location.replace(window.location.hash, "");
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
