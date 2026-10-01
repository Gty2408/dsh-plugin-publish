/**
 * Live verification against the real GitHub — opt-in, never part of `npm test`.
 *
 * ## Why this is separate, and gated
 *
 * It creates a real repository on a real account, and the `repo` scope cannot
 * delete repositories (that needs `delete_repo`). So a run leaves an artifact the
 * user must remove by hand. That is acceptable for a deliberate, occasional
 * check and unacceptable inside a test suite — which is exactly the mistake an
 * earlier version made.
 *
 * It therefore:
 *   - requires `--i-know-this-creates-a-repo`
 *   - reuses ONE fixed repository name, so repeated runs never accumulate
 *   - prints the cleanup URL at the end
 *
 * Usage:
 *   node test/live-verify.mjs --i-know-this-creates-a-repo
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONFIRM = "--i-know-this-creates-a-repo";
if (!process.argv.includes(CONFIRM)) {
	console.log("Refusing to run: this creates a real repository that cannot be deleted");
	console.log("with the `repo` scope alone.");
	console.log();
	console.log(`Re-run with:  node test/live-verify.mjs ${CONFIRM}`);
	process.exit(0);
}

const TOKEN_PATH = join(process.env.USERPROFILE ?? process.env.HOME, ".dsh", ".github-token");
let token;
try { token = readFileSync(TOKEN_PATH, "utf8").trim(); } catch { token = void 0; }
if (token === void 0 || token === "") {
	console.log(`No token at ${TOKEN_PATH}`);
	process.exit(1);
}

const plugin = await import("../lib/index.js");
const failures = [];
const check = (l, ok, d = "") => { if (!ok) failures.push(l); console.log(`${ok ? "PASS" : "FAIL"} ${l}${d ? ` ${d}` : ""}`); };

/* One fixed name, reused every run. */
const REPO = "dsh-plugin-publish-live-verify";
const OWNER = "Gty2408";
const PKG = "dsh-live-verify-probe";

const dir = join(tmpdir(), `dsh-live-verify-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "lib"), { recursive: true });
mkdirSync(join(dir, "test"), { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({
	name: PKG,
	version: "1.0.0",
	license: "MIT",
	description: "A live publish probe. Safe to delete.",
	dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } }
}, null, 2));
writeFileSync(join(dir, "cordis.patch.yml"), `- insert:\n    - id: ${PKG}\n      name: ${PKG}\n`);
writeFileSync(join(dir, "lib/client.js"), `window.__ModuleLoader__.load({ id: "${PKG}", factory: () => {} });\n`);
writeFileSync(join(dir, "test/x.test.mjs"), "// probe\n");

let registered;
plugin.apply({ commands: { register: (d) => { registered = d; return () => {}; } }, get: () => void 0 },
	{ token, owner: OWNER, branch: "main" });

console.log(`publishing ${PKG} to ${OWNER}/${REPO}\n`);
const out = await registered.handler({ rawInput: `${dir} --push --repo ${REPO} --category dev` });
console.log(out.text.split("\n").map((l) => `  ${l}`).join("\n"));
console.log();

check("the handler reported success", out.kind === "success", out.kind);

const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "live-verify", "x-github-api-version": "2022-11-28" };
const repoRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers });
check("the repository exists", repoRes.status === 200, String(repoRes.status));
if (repoRes.ok) {
	const repo = await repoRes.json();
	check("it is public", repo.private === false);
	check("the dsh-plugin topic is set", (repo.topics ?? []).includes("dsh-plugin"), JSON.stringify(repo.topics));
	const tree = await (await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`, { headers })).json();
	const paths = (tree.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path);
	console.log("\nuploaded:", paths.join(", "));
	check("the plugin files landed", ["package.json", "cordis.patch.yml", "lib/client.js"].every((p) => paths.includes(p)), JSON.stringify(paths));
}

rmSync(dir, { recursive: true, force: true });

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
console.log(`\nCleanup (the repo scope cannot delete it):`);
console.log(`  https://github.com/${OWNER}/${REPO}/settings  ->  Delete this repository`);
process.exit(failures.length === 0 ? 0 : 1);