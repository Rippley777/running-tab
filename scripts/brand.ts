import { readFile, writeFile } from "node:fs/promises";
const brand = JSON.parse(await readFile("brand.json", "utf8"));
const path = "src-tauri/tauri.conf.json",
  config = JSON.parse(await readFile(path, "utf8"));
config.productName = brand.name;
config.version = brand.version;
config.identifier = brand.identifier;
config.app.windows[0].title = brand.name;
config.bundle.shortDescription = brand.tagline;
await writeFile(path, JSON.stringify(config, null, 2) + "\n");
console.log("Native brand metadata updated from brand.json.");
