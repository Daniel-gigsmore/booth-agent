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

// Guests use the touchscreen, so the pointer is hidden - until a real mouse moves, then it shows
// for 3 s. pointerType keeps a tap (which also fires mouse-compat events) from revealing it.
let hidePointer: ReturnType<typeof setTimeout> | undefined;
addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  document.body.classList.add("mouse");
  clearTimeout(hidePointer);
  hidePointer = setTimeout(() => document.body.classList.remove("mouse"), 3000);
});

// No StrictMode: its double-run effects would fire the shutter twice in dev.
createRoot(document.getElementById("root")!).render(<App />);
