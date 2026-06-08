import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.resolve("src", "jest.cjs"), path.join(dist, "jest.cjs"));
