import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/manrope";
import "./styles.css";
import App from "./App";

// Screens are drawn at 1920x1080; scale the stage to whatever display the booth has.
const fit = () =>
  document.documentElement.style.setProperty(
    "--scale",
    String(Math.min(innerWidth / 1920, innerHeight / 1080)),
  );
fit();
addEventListener("resize", fit);

// No StrictMode: its double-run effects would fire the shutter twice in dev.
createRoot(document.getElementById("root")!).render(<App />);
