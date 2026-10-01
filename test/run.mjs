/**
 * Run every test for dsh-plugin-publish and report one verdict.
 *
 * All suites are hermetic: throwaway directories, no network. The GitHub client
 * is exercised through its pure helpers only, so no token is ever needed.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((n) => n.endsWith(".test.mjs")).sort();

const results = [];
for (const file of files) {
	console.log(`\n=== ${file} ===`);
	try {
		const out = execFileSync(process.execPath, [join(here, file)], { encoding: "utf8" });
		console.log(out.trim());
		results.push({ file, verdict: out.includes("ALL PASS") ? "PASS" : "FAIL" });
	} catch (error) {
		console.log(((error.stdout ?? "") + (error.stderr ?? "")).trim());
		results.push({ file, verdict: "FAIL" });
	}
}

console.log("\n================ summary ================");
for (const { file, verdict } of results) console.log(`${verdict.padEnd(6)} ${file}`);
const failed = results.filter((r) => r.verdict === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);