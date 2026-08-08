import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Service } = require("node-windows") as {
  Service: new (opts: Record<string, unknown>) => NodeJS.EventEmitter & { uninstall(): void };
};

const svc = new Service({
  name: "BoothAgent",
  script: path.join(__dirname, "..", "index.js"),
});

svc.on("uninstall", () => {
  console.log("BoothAgent service uninstalled.");
});
svc.on("error", (err: unknown) => {
  console.error("Service uninstall error:", err);
  process.exitCode = 1;
});

console.log("Uninstalling BoothAgent Windows service (requires an elevated/Administrator prompt)...");
svc.uninstall();
