import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const entryPath = path.join(repoRoot, "src", "index.ts");

const candidateSettingsPaths = [
  path.join(os.homedir(), ".config", "zed", "settings.json"),
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Zed",
    "settings.json",
  ),
];

const providerConfig = {
  type: "custom",
  command: tsxPath,
  args: [entryPath],
  env: {},
};

const ensureDir = async (filePath: string) => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
};

const readSettings = async (filePath: string) => {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeSettings = async (filePath: string, settings: Record<string, unknown>) => {
  await ensureDir(filePath);
  const contents = `${JSON.stringify(settings, null, 2)}\n`;
  await fs.writeFile(filePath, contents, "utf8");
};

const pickSettingsPath = async () => {
  for (const candidate of candidateSettingsPaths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidateSettingsPaths[0];
};

const updateSettings = async () => {
  const settingsPath = await pickSettingsPath();
  const settings = (await readSettings(settingsPath)) as Record<string, unknown>;
  const assistant = (settings.assistant ?? {}) as Record<string, unknown>;
  const providers = (assistant.providers ?? {}) as Record<string, unknown>;

  providers["pi-acp"] = providerConfig;
  assistant.providers = providers;
  settings.assistant = assistant;

  await writeSettings(settingsPath, settings);
  console.log(`Updated Zed settings: ${settingsPath}`);
};

updateSettings().catch((error) => {
  console.error("Failed to update Zed settings:", error);
  process.exit(1);
});
