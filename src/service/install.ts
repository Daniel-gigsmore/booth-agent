import path from "node:path";
// node-windows has no types package; the shape used here is documented at
// https://github.com/coreybutler/node-windows#windows-service
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Service } = require("node-windows") as {
  Service: new (
    opts: Record<string, unknown>
  ) => NodeJS.EventEmitter & { install(): void; start(): void };
};

const svc = new Service({
  name: "BoothAgent",
  description: "Local photobooth agent: owns the camera and printer, exposes them on 127.0.0.1:7070.",
  script: path.join(__dirname, "..", "index.js"),
  workingDirectory: path.join(__dirname, "..", ".."),
  env: [
    {
      name: "BOOTH_CONFIG_PATH",
      value: process.env["BOOTH_CONFIG_PATH"] ?? path.join(__dirname, "..", "..", "booth.config.json"),
    },
  ],
});

svc.on("install", () => {
  console.log("BoothAgent service installed. Starting it now...");
  svc.start();
});
svc.on("alreadyinstalled", () => {
  console.log("BoothAgent service is already installed.");
});
svc.on("start", () => {
  console.log("BoothAgent service started.");
});
svc.on("error", (err: unknown) => {
  console.error("Service install error:", err);
  process.exitCode = 1;
});

console.log("Installing BoothAgent as a Windows service (requires an elevated/Administrator prompt)...");
svc.install();
