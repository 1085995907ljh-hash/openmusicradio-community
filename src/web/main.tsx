import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./hallmark.css";
import "./console-redesign.css";
import "./program-builder.css";
import "./button-states.css";
import "./settings.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Radio console root was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
