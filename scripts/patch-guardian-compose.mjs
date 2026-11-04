// Run inside the built image with only the Compose directory mounted, no wallet volume.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const { parseDocument } = createRequire(path.resolve("package.json"))("yaml");
const [filename, image, apply] = process.argv.slice(2);
if (!filename || !/^local\/wallet-guardian:trading-[0-9a-f]{7,40}$/.test(image ?? "") || (apply && apply !== "--apply")) throw new Error("Explicit Compose file and reviewed trading image required");
if (fs.lstatSync(filename).isSymbolicLink()) throw new Error("Refusing a symlinked Compose file");
const raw = fs.readFileSync(filename, "utf8"), doc = parseDocument(raw);
if (doc.errors.length) throw new Error("Invalid Compose YAML");
const before = doc.toJS(), guardian = before.services?.guardian;
if (!guardian || guardian.network_mode !== "service:netns" || !before.services.netns || guardian.ports?.length) throw new Error("Expected existing private guardian/netns topology; review manually instead of replacing it");
doc.setIn(["services", "guardian", "image"], image);
doc.setIn(["services", "guardian", "stop_grace_period"], "130s");
const expected = structuredClone(before); expected.services.guardian.image = image; expected.services.guardian.stop_grace_period = "130s";
if (JSON.stringify(doc.toJS()) !== JSON.stringify(expected)) throw new Error("Unexpected Compose changes");
if (apply) {
  const suffix = Date.now() + "-" + randomBytes(4).toString("hex");
  fs.writeFileSync(filename + ".before-trading-" + suffix, raw, { flag: "wx", mode: 0o600 });
  const temporary = filename + ".new-" + suffix;
  fs.writeFileSync(temporary, doc.toString(), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, filename);
}
console.log(JSON.stringify({ applied: !!apply, image, changes: ["services.guardian.image", "services.guardian.stop_grace_period"], otherServicesPreserved: true }));
