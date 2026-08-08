import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import chokidar, { FSWatcher } from "chokidar";
import { BoothConfig, BoothConfigSchema } from "./schema";
import { createLogger } from "../util/logger";

const log = createLogger("config");

export type ConfigChangeListener = (config: BoothConfig, previous: BoothConfig) => void;

/**
 * Loads booth.config.json and re-parses it on change (chokidar watch) so the
 * agent never needs a restart to pick up a new template path, hot folder, etc.
 * Consumers read the latest value via `.current`; a bad edit is logged and
 * ignored so a malformed file on disk can never take the agent down.
 */
export class ConfigStore {
  private configPath: string;
  private currentConfig: BoothConfig;
  private watcher: FSWatcher | undefined;
  private listeners: Set<ConfigChangeListener> = new Set();

  private constructor(configPath: string, initial: BoothConfig) {
    this.configPath = configPath;
    this.currentConfig = initial;
  }

  static load(configPath: string): ConfigStore {
    const resolved = path.resolve(configPath);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    const initial = ConfigStore.readAndValidate(resolved);
    return new ConfigStore(resolved, initial);
  }

  private static readAndValidate(resolved: string): BoothConfig {
    const raw = readFileSync(resolved, "utf-8");
    const json: unknown = JSON.parse(raw);
    return BoothConfigSchema.parse(json);
  }

  get current(): BoothConfig {
    return this.currentConfig;
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.configPath, { ignoreInitial: true });
    this.watcher.on("change", () => {
      try {
        const next = ConfigStore.readAndValidate(this.configPath);
        const previous = this.currentConfig;
        this.currentConfig = next;
        log.info("booth.config.json reloaded");
        for (const listener of this.listeners) {
          listener(next, previous);
        }
      } catch (err) {
        log.error("Failed to reload booth.config.json, keeping previous config", err);
      }
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
