/**
 * Tools Manager
 *
 * Manages installation and configuration of external tools and MCP servers.
 */

import type {
  ConwayClient,
  AutomatonDatabase,
  InstalledTool,
} from "../types.js";
import { logModification } from "./audit-log.js";
import { ulid } from "ulid";
import { shellQuote } from "./runtime-source.js";

const REGISTRY_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?|[a-zA-Z][a-zA-Z0-9._-]*))?$/;

/**
 * Install an npm package globally in the sandbox.
 */
export async function installNpmPackage(
  conway: ConwayClient,
  db: AutomatonDatabase,
  packageName: string,
  options: { allowLifecycleScripts?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
  // Registry packages only: no local paths, Git URLs, options or shell syntax.
  if (!REGISTRY_PACKAGE_RE.test(packageName)) {
    return {
      success: false,
      error: `Invalid package name: ${packageName}`,
    };
  }

  const metadata = await conway.exec(
    `npm view ${shellQuote(packageName)} version dist.integrity --json`,
    30_000,
  );
  if (metadata.exitCode !== 0) return { success: false, error: "Failed to resolve npm package metadata" };
  let version: string;
  let integrity: string;
  try {
    const manifest = JSON.parse(metadata.stdout);
    version = manifest.version;
    integrity = manifest["dist.integrity"] ?? manifest.dist?.integrity;
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      throw new Error("Invalid registry integrity metadata");
    }
  } catch {
    return { success: false, error: "Registry did not provide one exact version and a supported integrity digest" };
  }
  const unversionedName = packageName.replace(/@[^/]+$/, "");
  const pinnedPackage = `${unversionedName}@${version}`;
  // Native packages sometimes require lifecycle scripts. Keep that function
  // available, while allowing an operator to explicitly suppress scripts.
  const allowScripts = options.allowLifecycleScripts !== false;
  const verifyArchive = `const fs=require("fs"),crypto=require("crypto"),path=require("path");const dir=process.argv[1],integrity=process.argv[2];const rows=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));if(rows.length!==1||rows[0].integrity!==integrity)throw Error("npm archive metadata integrity mismatch");const name=rows[0].filename;if(typeof name!=="string"||path.basename(name)!==name)throw Error("Unsafe archive filename");const [algorithm,expected]=integrity.split("-");const actual=crypto.createHash(algorithm).update(fs.readFileSync(path.join(dir,name))).digest("base64");if(actual!==expected)throw Error("npm archive checksum mismatch");process.stdout.write(name);`;
  const installCommand = [
    "set -eu",
    "package_tmp=$(mktemp -d)",
    "trap 'rm -rf \"$package_tmp\"' EXIT",
    `npm pack --ignore-scripts --pack-destination "$package_tmp" --json -- ${shellQuote(pinnedPackage)} > "$package_tmp/package.json"`,
    `package_archive=$(node -e ${shellQuote(verifyArchive)} "$package_tmp" ${shellQuote(integrity)})`,
    `npm install -g --no-audit --no-fund${allowScripts ? "" : " --ignore-scripts"} -- "$package_tmp/$package_archive"`,
  ].join("; ");
  const result = await conway.exec(installCommand, 120_000);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `npm install failed: ${result.stderr}`,
    };
  }

  // Record in database
  const tool: InstalledTool = {
    id: ulid(),
    name: packageName,
    type: "custom",
    config: {
      source: "npm", installCommand, requestedPackage: packageName,
      resolvedPackage: pinnedPackage, integrity, allowLifecycleScripts: allowScripts,
    },
    installedAt: new Date().toISOString(),
    enabled: true,
  };

  db.installTool(tool);

  logModification(db, "tool_install", `Installed npm package: ${pinnedPackage}; lifecycle scripts ${allowScripts ? "enabled (executes third-party code)" : "disabled"}`, {
    reversible: true,
  });

  return { success: true };
}

/**
 * Install an MCP server.
 * The automaton can add new capabilities by installing MCP servers.
 */
export async function installMcpServer(
  conway: ConwayClient,
  db: AutomatonDatabase,
  name: string,
  command: string,
  args?: string[],
  env?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  // Record in database
  const tool: InstalledTool = {
    id: ulid(),
    name: `mcp:${name}`,
    type: "mcp",
    config: { command, args, env },
    installedAt: new Date().toISOString(),
    enabled: true,
  };

  db.installTool(tool);

  logModification(
    db,
    "mcp_install",
    `Installed MCP server: ${name} (${command})`,
    { reversible: true },
  );

  return { success: true };
}

/**
 * List all installed tools.
 */
export function listInstalledTools(
  db: AutomatonDatabase,
): InstalledTool[] {
  return db.getInstalledTools();
}

/**
 * Remove (disable) an installed tool.
 */
export function removeTool(
  db: AutomatonDatabase,
  toolId: string,
): void {
  db.removeTool(toolId);
  logModification(db, "tool_install", `Removed tool: ${toolId}`, {
    reversible: true,
  });
}
